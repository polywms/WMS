/*
 * Tujuan: Persistensi IndexedDB, sinkronisasi Admin, dan refresh baca otomatis untuk User.
 * Caller: main.js, core.js, dan handler kontrol sinkronisasi di index.html.
 * Dependensi: auth.js (Admin-authorized writes), config.js (db, antrean, sesi), IndexedDB, API_URL.
 * Main Functions: initDB() migrates the IndexedDB outbox; saveDB()/saveDBBatch() atomically store records and queue; sync handlers acknowledge revisions or resolve conflicts.
 * Side Effects: IndexedDB item/outbox read/write, sync-log localStorage, background User GET, and user-triggered Admin POST/GET requests.
 */
// js/database.js

let lastFetchedCloudOffBs = [];
let hiddenOffBsBoxes = [];

// Variabel TAB PACKING
let packingSession = JSON.parse(localStorage.getItem('wms_packing')) || [];
let collyList = JSON.parse(localStorage.getItem('wms_colly_list')) || [];
let activeColly = localStorage.getItem('wms_active_colly') || null;
let isCloudSyncing = false;
let userRefreshPromise = null;
let pendingSyncConflicts = [];

function updateSyncUI(text) { const el = document.getElementById('syncStatus'); if(el) el.innerHTML = text; }

function setSyncBusy(busy) {
    const button = document.getElementById('syncCloudButton');
    if (!button) return;
    button.classList.toggle('sync-busy', busy);
    button.setAttribute('aria-busy', String(busy));
}

function updateLocalSyncStatus() {
    if (syncQueue.length > 0) {
        updateSyncUI(`<i class="fas fa-cloud-arrow-up"></i> ${syncQueue.length} menunggu upload`);
    } else {
        updateSyncUI('<i class="fas fa-cloud-check"></i> 0 perubahan menunggu');
    }
}

function closeSyncConflictModal() {
    const modal = document.getElementById('syncConflictModal');
    if (modal) modal.style.display = 'none';
}

function renderSyncConflicts() {
    const modal = document.getElementById('syncConflictModal');
    const container = document.getElementById('syncConflictList');
    if (!modal || !container) return;
    container.replaceChildren();
    pendingSyncConflicts.forEach(conflict => {
        const localItem = syncQueue.find(item => String(item.id) === String(conflict.clientId))
            || localItems.find(item => String(item.id) === String(conflict.clientId));
        const cloudItem = conflict.cloudItem || {};
        const section = document.createElement('section');
        section.className = 'sync-conflict-item';
        const heading = document.createElement('h4');
        heading.textContent = localItem?.partNo || cloudItem.partNo || `ID ${conflict.clientId}`;
        section.appendChild(heading);
        [
            ['Lokal', localItem || {}],
            ['Cloud', cloudItem]
        ].forEach(([label, item]) => {
            const detail = document.createElement('p');
            detail.textContent = `${label} (rev ${Number(item.revision) || 0}) | Qty sistem: ${Number(item.sysQty) || 0} | Lokasi: ${JSON.stringify(item.locations || {})} | Hitungan: ${JSON.stringify(item.opnameCounts || {})}`;
            section.appendChild(detail);
        });
        const actions = document.createElement('div');
        actions.className = 'sync-conflict-actions';
        const useCloudButton = document.createElement('button');
        useCloudButton.type = 'button';
        useCloudButton.className = 'btn btn-outline';
        useCloudButton.textContent = 'Gunakan Cloud';
        useCloudButton.addEventListener('click', () => resolveSyncConflict(conflict.clientId, 'cloud'));
        const keepLocalButton = document.createElement('button');
        keepLocalButton.type = 'button';
        keepLocalButton.className = 'btn btn-primary';
        keepLocalButton.textContent = 'Pertahankan Lokal & antrekan ulang';
        keepLocalButton.addEventListener('click', () => resolveSyncConflict(conflict.clientId, 'local'));
        actions.append(useCloudButton, keepLocalButton);
        section.appendChild(actions);
        container.appendChild(section);
    });
    modal.style.display = pendingSyncConflicts.length > 0 ? 'flex' : 'none';
}

async function resolveSyncConflict(clientId, resolution) {
    const conflict = pendingSyncConflicts.find(item => String(item.clientId) === String(clientId));
    if (!conflict) return;
    const localItem = syncQueue.find(item => String(item.id) === String(clientId));
    const cloudItem = conflict.cloudItem;
    if (!localItem || !cloudItem) {
        showToast('Data konflik tidak lengkap. Antrean tetap dipertahankan.');
        return;
    }

    const resolvedItem = resolution === 'cloud'
        ? { ...localItem, ...cloudItem, id: cloudItem.id }
        : { ...localItem, id: cloudItem.id, revision: conflict.revision };
    if (resolution === 'cloud') delete resolvedItem.localVersion;
    try {
        await new Promise((resolve, reject) => {
            let tx;
            try {
                tx = db.transaction(['items', 'outbox'], 'readwrite');
                const itemsStore = tx.objectStore('items');
                const outboxStore = tx.objectStore('outbox');
                if (String(localItem.id) !== String(cloudItem.id)) {
                    itemsStore.delete(localItem.id);
                    outboxStore.delete(localItem.id);
                }
                itemsStore.put(resolvedItem);
                if (resolution === 'cloud') outboxStore.delete(resolvedItem.id);
                else outboxStore.put(resolvedItem);
            } catch (error) {
                reject(error);
                return;
            }
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan resolusi konflik.'));
            tx.onabort = () => reject(tx.error || new Error('Resolusi konflik dibatalkan.'));
        });
        pendingSyncConflicts = pendingSyncConflicts.filter(item => String(item.clientId) !== String(clientId));
        await loadSyncQueueFromOutbox();
        await loadDataFromLocal();
        updateLocalSyncStatus();
        renderSyncConflicts();
        showToast(resolution === 'cloud'
            ? `${cloudItem.partNo}: versi Cloud diterapkan.`
            : `${localItem.partNo}: versi lokal dipertahankan untuk upload ulang.`);
    } catch (error) {
        console.error('Resolusi konflik gagal:', error);
        showToast(`Resolusi konflik gagal: ${error.message}. Antrean tetap tersimpan.`);
    }
}

function areWmsRecordsEqual(left, right) {
    const normalize = value => {
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === 'object') {
            return Object.keys(value).sort().reduce((result, key) => {
                result[key] = normalize(value[key]);
                return result;
            }, {});
        }
        return value;
    };
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function refreshUserDataInBackground() {
    if (currentRole !== 'user') return Promise.resolve(false);
    if (userRefreshPromise) return userRefreshPromise;
    userRefreshPromise = downloadFromServer({ background: true, reloadOnUpdate: true })
        .finally(() => { userRefreshPromise = null; });
    return userRefreshPromise;
}

function migrateLegacySyncQueue() {
    if (legacySyncQueue.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = db.transaction(['outbox', 'meta'], 'readwrite');
            const store = tx.objectStore('outbox');
            const meta = tx.objectStore('meta');
            const markerRequest = meta.get('legacyQueueMigrated');
            markerRequest.onsuccess = () => {
                if (markerRequest.result) return;
                legacySyncQueue.forEach(item => {
                    if (item && item.id !== undefined) store.put({ ...item, revision: Number(item.revision) || 0 });
                });
                meta.put({ id: 'legacyQueueMigrated' });
            };
            markerRequest.onerror = () => tx.abort();
        } catch (error) {
            reject(error);
            return;
        }
        tx.oncomplete = () => {
            try { localStorage.removeItem('wms_syncQueue'); } catch (error) { console.warn('Antrean legacy tetap tersimpan di localStorage:', error); }
            legacySyncQueue = [];
            resolve();
        };
        tx.onerror = () => reject(tx.error || new Error('Migrasi antrean upload gagal.'));
        tx.onabort = () => reject(tx.error || new Error('Migrasi antrean upload dibatalkan.'));
    });
}

function loadSyncQueueFromOutbox() {
    return new Promise((resolve, reject) => {
        const request = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
        request.onsuccess = () => {
            syncQueue = request.result || [];
            resolve(syncQueue);
        };
        request.onerror = () => reject(request.error || new Error('Gagal membaca antrean upload.'));
    });
}

function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = e => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('items')) database.createObjectStore('items', { keyPath: 'id' });
            if (!database.objectStoreNames.contains('outbox')) database.createObjectStore('outbox', { keyPath: 'id' });
            if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'id' });
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = async e => { 
            db = e.target.result; 
            try {
                await migrateLegacySyncQueue();
                await loadSyncQueueFromOutbox();
                await loadDataFromLocal();
                updateLocalSyncStatus();
                resolve();
            } catch (error) {
                reject(error);
            }
        };
    });
}

function loadDataFromLocal() {
    return new Promise(resolve => {
        const request = db.transaction('items', 'readonly').objectStore('items').getAll();
        request.onsuccess = async e => {
            localItems = e.target.result || [];
            localItems.forEach(i => {
                if(!i.locations) i.locations = {};
                if(!i.lastOpnameDate) i.lastOpnameDate = '';
            });
            localItems.sort((a,b) => a.partNo.localeCompare(b.partNo));
            if(typeof populateFilters === 'function') populateFilters();
            if(typeof restoreOpnameSession === 'function') await restoreOpnameSession();
            if(currentTab === 'opname' && typeof handleOpnameRender === 'function') handleOpnameRender(true);
            if(currentTab === 'simpan' && typeof renderSimpanList === 'function') renderSimpanList(true);
            if(currentTab === 'data' && typeof renderDataList === 'function') renderDataList(true);
            if(currentTab === 'packing' && typeof renderPackingList === 'function') { renderCollyUI(); renderPackingList(); }
            if(currentTab === 'offbs' && typeof renderOffBsList === 'function') renderOffBsList();
            resolve(localItems);
        };
        request.onerror = () => resolve([]);
    });
}

async function downloadFromServer(options = {}) {
    const backgroundUserRefresh = options.background === true && currentRole === 'user';
    if (!backgroundUserRefresh) window.closeSyncModal?.();
    if (!backgroundUserRefresh && !requireAdminAccess('mengunduh data cloud')) return false;
    if (!navigator.onLine) {
        updateSyncUI('<i class="fas fa-circle" style="color: #ef4444; font-size: 0.6rem; margin-right: 4px;"></i> Offline; data lokal aman');
        if (!backgroundUserRefresh) showToast('Tidak ada koneksi. Data lokal tetap tersimpan.');
        return false;
    }
    if (isSyncing || isCloudSyncing) {
        if (!backgroundUserRefresh) showToast('Sinkronisasi sedang berjalan. Tunggu hingga selesai.');
        return false;
    }
    isCloudSyncing = true;
    if (!backgroundUserRefresh) setSyncBusy(true);
    updateSyncUI(backgroundUserRefresh
        ? '<i class="fas fa-spinner fa-spin"></i> Memeriksa update; data lokal tetap tersedia'
        : '<i class="fas fa-spinner fa-spin"></i> Mengunduh data...');
    let timeoutId;
    try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), 30000);
        const response = await fetch(API_URL, { redirect: "follow", signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`Cloud returned ${response.status}`);
        const result = await response.json();
        if (result.status !== 'success' || !Array.isArray(result.data)) {
            throw new Error(result.message || 'Respons data cloud tidak valid.');
        }

        const localRecords = await new Promise((resolve, reject) => {
            const request = db.transaction('items', 'readonly').objectStore('items').getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error('Gagal membaca data lokal.'));
        });
        const localById = new Map(localRecords.map(item => [item.id, item]));
        const localByKey = new Map(localRecords.map(item => [getWmsItemIdentityKey(item), item]));
        const pendingIds = new Set(syncQueue.map(item => item.id));
        const pendingKeys = new Set(syncQueue.map(getWmsItemIdentityKey));
        const mergeCandidates = result.data
            .filter(item => item && item.id !== undefined && item.id !== null)
            .map(cloudItem => {
                const localItem = localById.get(cloudItem.id)
                    || localByKey.get(getWmsItemIdentityKey(cloudItem));
                if (pendingIds.has(cloudItem.id) || pendingKeys.has(getWmsItemIdentityKey(cloudItem))) {
                    return null;
                }
                if (!localItem) return { cloudItem, merged: { ...cloudItem }, locationConflict: false };
                const localUpdatedAt = Number(localItem.updated_at) || Date.parse(localItem.updated_at) || 0;
                const cloudUpdatedAt = Number(cloudItem.updated_at) || Date.parse(cloudItem.updated_at) || 0;
                const localLocations = localItem.locations || {};
                const cloudLocations = cloudItem.locations || {};
                const locationConflict = !areWmsLocationsEqual(localLocations, cloudLocations);
                if (localUpdatedAt > cloudUpdatedAt) {
                    return { cloudItem, merged: localItem, locationConflict: false };
                }
                const merged = { ...localItem, ...cloudItem, id: localItem.id };
                if ((!cloudItem.opnameCounts || Object.keys(cloudItem.opnameCounts).length === 0)
                    && localItem.opnameCounts
                    && Object.keys(localItem.opnameCounts).length > 0) {
                    merged.opnameCounts = localItem.opnameCounts;
                }
                return { cloudItem, localItem, merged, locationConflict };
            });
        const candidates = mergeCandidates.filter(Boolean);
        const conflictCandidates = candidates.filter(candidate => candidate.locationConflict);
        const useCloudLocations = !backgroundUserRefresh && conflictCandidates.length > 0
            && confirm(`Cloud dan lokal memiliki lokasi berbeda pada ${conflictCandidates.length} part. Gunakan lokasi dari Cloud untuk part tersebut? Pilih Batal untuk mempertahankan lokasi lokal yang konflik.`);
        const mergedItems = candidates.map(candidate => {
            if (candidate.locationConflict && !backgroundUserRefresh && !useCloudLocations) {
                candidate.merged.locations = candidate.localItem.locations || {};
            }
            return candidate.merged;
        });
        const changedItems = mergedItems.filter(item => {
            const localItem = localById.get(item.id)
                || localByKey.get(getWmsItemIdentityKey(item));
            return !localItem || !areWmsRecordsEqual(localItem, item);
        });

        let appliedDownloadCount = 0;
        if (changedItems.length > 0) {
            await new Promise((resolve, reject) => {
                let tx;
                try {
                    tx = db.transaction(['items', 'outbox'], 'readwrite');
                    const store = tx.objectStore('items');
                    const outboxRequest = tx.objectStore('outbox').getAll();
                    outboxRequest.onsuccess = () => {
                        const pendingIds = new Set(outboxRequest.result.map(item => String(item.id)));
                        const pendingKeys = new Set(outboxRequest.result.map(getWmsItemIdentityKey));
                        changedItems.forEach(item => {
                            if (pendingIds.has(String(item.id)) || pendingKeys.has(getWmsItemIdentityKey(item))) return;
                            store.put(item);
                            appliedDownloadCount++;
                        });
                    };
                    outboxRequest.onerror = () => tx.abort();
                } catch (error) {
                    reject(error);
                    return;
                }
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan hasil download.'));
                tx.onabort = () => reject(tx.error || new Error('Download lokal dibatalkan.'));
            });
            if (backgroundUserRefresh && options.reloadOnUpdate && appliedDownloadCount > 0) {
                updateSyncUI(`<i class="fas fa-check-circle"></i> ${appliedDownloadCount} update diterapkan; memuat ulang...`);
                window.location.reload();
                return true;
            }
            if (appliedDownloadCount > 0) await loadDataFromLocal();
        }
        updateSyncUI(backgroundUserRefresh
            ? '<i class="fas fa-check-circle"></i> Data lokal sudah terbaru'
            : `<i class="fas fa-check-circle"></i> Download selesai; ${appliedDownloadCount} data diperbarui, konflik lokasi: ${conflictCandidates.length}`);
        if (!backgroundUserRefresh) {
            showToast(`Download selesai: ${appliedDownloadCount} data diperbarui. ${conflictCandidates.length} konflik lokasi ${useCloudLocations ? 'diambil dari Cloud' : 'dipertahankan lokal'}. Antrean pending tidak dihapus.`);
        }
        return true;
    } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);
        console.error('Download data cloud gagal:', error);
        updateSyncUI(error.name === 'AbortError'
            ? '<i class="fas fa-times-circle"></i> Download timeout; data lokal aman'
            : '<i class="fas fa-times-circle"></i> Download gagal; data lokal aman');
        if (!backgroundUserRefresh) showToast(`Download gagal: ${error.message}. Data lokal tidak dihapus.`);
        return false;
    } finally {
        isCloudSyncing = false;
        if (!backgroundUserRefresh) setSyncBusy(false);
    }
}

function saveDB(item, actionName = "UPDATE", actionDetail = "") {
    if (!requireAdminAccess('menyimpan perubahan lokal')) return false;
    const record = { ...item, updated_at: Date.now(), revision: Number(item.revision) || 0, localVersion: `${Date.now()}-${Math.random()}` };
    Object.assign(item, record);
    const tx = db.transaction(['items', 'outbox'], 'readwrite');
    tx.objectStore('items').put(record);
    tx.objectStore('outbox').put(record);
    tx.oncomplete = () => {
        const queuedIndex = syncQueue.findIndex(queuedItem => queuedItem.id === record.id);
        if (queuedIndex >= 0) syncQueue[queuedIndex] = record;
        else syncQueue.push(record);
        syncLogs.push({ partNo: record.partNo, action: actionName, detail: actionDetail || "Update Qty/Lokasi", timestamp: Date.now() });
        syncLogs = syncLogs.slice(-100);
        try { localStorage.setItem('wms_syncLogs', JSON.stringify(syncLogs)); } catch (error) { console.warn('Log lokal gagal disimpan:', error); }
        updateLocalSyncStatus();
    };
    tx.onerror = () => {
        updateSyncUI('<i class="fas fa-times-circle"></i> Gagal menyimpan lokal dan antrean');
        showToast('Perubahan gagal disimpan. Silakan ulangi scan.');
    };
    tx.onabort = tx.onerror;
}

function saveDBBatch(items, actionName = "UPDATE", actionDetail = "") {
    if (!requireAdminAccess('menyimpan perubahan lokal')) {
        return Promise.reject(new Error('Sesi Admin tidak aktif atau telah kedaluwarsa.'));
    }
    if (!Array.isArray(items) || items.length === 0) return Promise.resolve([]);

    const timestamp = Date.now();
    const records = items.map(item => ({
        ...item,
        updated_at: timestamp,
        revision: Number(item.revision) || 0,
        localVersion: `${timestamp}-${Math.random()}`
    }));
    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = db.transaction(['items', 'outbox'], 'readwrite');
            const store = tx.objectStore('items');
            const outbox = tx.objectStore('outbox');
            records.forEach(item => {
                store.put(item);
                outbox.put(item);
            });
        } catch (error) {
            reject(error);
            return;
        }

        tx.oncomplete = () => {
            records.forEach(item => {
                const queuedIndex = syncQueue.findIndex(queuedItem => queuedItem.id === item.id);
                if (queuedIndex >= 0) syncQueue[queuedIndex] = item;
                else syncQueue.push(item);
                syncLogs.push({
                    partNo: item.partNo,
                    action: actionName,
                    detail: typeof actionDetail === 'function' ? actionDetail(item) : actionDetail,
                    timestamp
                });
            });
            syncLogs = syncLogs.slice(-100);
            try { localStorage.setItem('wms_syncLogs', JSON.stringify(syncLogs)); } catch (error) { console.warn('Log lokal gagal disimpan:', error); }
            updateLocalSyncStatus();
            resolve(records);
        };
        tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan batch ke IndexedDB.'));
        tx.onabort = () => reject(tx.error || new Error('Penyimpanan batch dibatalkan.'));
    });
}

function acknowledgeSyncBatch(batch, revisions) {
    if (!Array.isArray(revisions) || revisions.length !== batch.length) {
        return Promise.reject(new Error('Cloud tidak mengirim acknowledgment revision lengkap.'));
    }
    const revisionById = new Map(revisions.map(entry => [String(entry.clientId), entry]));
    if (batch.some(item => !revisionById.has(String(item.id)))) {
        return Promise.reject(new Error('Acknowledgment Cloud tidak cocok dengan antrean lokal.'));
    }

    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = db.transaction(['items', 'outbox'], 'readwrite');
            const itemsStore = tx.objectStore('items');
            const outboxStore = tx.objectStore('outbox');
            batch.forEach(sentItem => {
                const acknowledgement = revisionById.get(String(sentItem.id));
                const queuedRequest = outboxStore.get(sentItem.id);
                queuedRequest.onsuccess = () => {
                    const queuedItem = queuedRequest.result;
                    if (queuedItem) {
                        const sameSnapshot = queuedItem.localVersion
                            ? queuedItem.localVersion === sentItem.localVersion
                            : areWmsRecordsEqual(queuedItem, sentItem);
                        if (sameSnapshot) outboxStore.delete(sentItem.id);
                        else outboxStore.put({ ...queuedItem, revision: acknowledgement.revision });
                    }
                    const itemRequest = itemsStore.get(sentItem.id);
                    itemRequest.onsuccess = () => {
                        if (!itemRequest.result) return;
                        const savedItem = {
                            ...itemRequest.result,
                            revision: acknowledgement.revision
                        };
                        if (queuedItem && (queuedItem.localVersion
                            ? queuedItem.localVersion === sentItem.localVersion
                            : areWmsRecordsEqual(queuedItem, sentItem))) {
                            savedItem.updated_at = acknowledgement.updated_at || savedItem.updated_at;
                            delete savedItem.localVersion;
                        }
                        itemsStore.put(savedItem);
                    };
                };
            });
        } catch (error) {
            reject(error);
            return;
        }
        tx.oncomplete = async () => {
            try {
                await loadSyncQueueFromOutbox();
                await loadDataFromLocal();
                resolve();
            } catch (error) {
                reject(error);
            }
        };
        tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan acknowledgment Cloud.'));
        tx.onabort = () => reject(tx.error || new Error('Penyimpanan acknowledgment Cloud dibatalkan.'));
    });
}

async function processSyncQueue() {
    if (!requireAdminAccess('mengunggah antrean perubahan')) return false;
    if (isSyncing || syncQueue.length === 0 || !navigator.onLine) return false;
    isSyncing = true; 
    updateSyncUI('<i class="fas fa-sync"></i> Syncing...');
    try {
        let batchNum = 0;
        
        // Process in batches to prevent OOM crashes
        while (syncQueue.length > 0) {
            batchNum++;
            const batch = syncQueue.slice(0, MAX_SYNC_BATCH);
            const uploadItems = batch.map(({ localVersion, ...item }) => item);
            
            const payload = { action: "sync", data: uploadItems, logs: batchNum === 1 ? syncLogs : [], batch: batchNum };
            updateSyncUI(`<i class="fas fa-sync"></i> Syncing (Batch ${batchNum})...`);
            
            const response = await postWmsAction(payload);
            
            if (!response.ok) throw new Error(`Cloud returned ${response.status}`);
            const result = await response.json();
            if (result.status === 'conflict') {
                pendingSyncConflicts = result.conflicts || [];
                renderSyncConflicts();
                updateSyncUI(`<i class="fas fa-triangle-exclamation"></i> ${pendingSyncConflicts.length} konflik; antrean dipertahankan`);
                return false;
            }
            if (result.status === "success") {
                await acknowledgeSyncBatch(batch, result.revisions);
            } else {
                throw new Error(result.message || 'Sync rejected');
            }
        }
        
        if (syncQueue.length === 0) {
            pendingSyncConflicts = [];
            closeSyncConflictModal();
            syncLogs = syncLogs.slice(-100); // Keep only last 100 logs
            localStorage.setItem('wms_syncLogs', JSON.stringify(syncLogs));
            updateSyncUI('<i class="fas fa-check-circle"></i> Upload berhasil; cloud mengonfirmasi revision');
        }
        return true;
    } catch (error) {
        console.error('Upload antrean gagal:', error);
        updateSyncUI('<i class="fas fa-circle" style="color: #ef4444; font-size: 0.6rem; margin-right: 4px;"></i> Sync gagal; data lokal aman');
        return false;
    } finally { 
        isSyncing = false; 
    }
}

async function fetchCloudOffBs() {
    if (!navigator.onLine) { if(typeof showToast === 'function') showToast("Gagal: Koneksi internet terputus!"); return; }
    const modal = document.getElementById('cloudOffBsModal'); const content = document.getElementById('cloudOffBsContent');
    modal.style.display = 'flex';
    content.innerHTML = `<div style="text-align:center; padding:40px; color:#64748b;"><i class="fas fa-sync fa-spin fa-2x" style="color:var(--offbs); margin-bottom:15px;"></i><div>Sedang memuat data dari Google Sheets...</div></div>`;
    try {
        const response = await postWmsAction({ action: "get_cloud_off_bs" }, false);
        const result = await response.json();
        if (result.status === "success" && Array.isArray(result.data)) {
            lastFetchedCloudOffBs = result.data; renderCloudAccordion(result.data);
        } else { content.innerHTML = `<div style="color:var(--danger); text-align:center; padding:20px;">Gagal mengambil data valid.</div>`; }
    } catch (err) { content.innerHTML = `<div style="color:var(--danger); text-align:center; padding:20px;"><i class="fas fa-exclamation-triangle fa-2x"></i><br>Gagal terhubung ke Server Cloud.</div>`; }
}

function renderCloudAccordion(data) {
    const container = document.getElementById('cloudOffBsContent');
    const validData = data.filter(item => item.box && item.partNo);
    if (validData.length === 0) { container.innerHTML = `<div style="text-align:center; padding:40px; color:#94a3b8;"><i class="fas fa-box-open fa-3x" style="margin-bottom:15px; opacity:0.5;"></i><div>Database kosong.</div></div>`; return; }

    const groupedData = {}; let totalAllPcs = 0;
    validData.forEach(item => {
        const boxName = item.box.trim().toUpperCase();
        if (!groupedData[boxName]) groupedData[boxName] = { totalQty: 0, items: [] };
        groupedData[boxName].totalQty += parseInt(item.qty) || 0; groupedData[boxName].items.push(item);
        totalAllPcs += parseInt(item.qty) || 0;
    });

    const sortedBoxes = Object.keys(groupedData).sort();
    let html = `
    <div style="margin-bottom: 15px;">
        <select id="cloudBoxFilter" onchange="filterCloudBoxes(this.value)" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid #cbd5e1; font-weight:bold; color:var(--text); background:white; font-size:0.9rem; outline:none;">
            <option value="ALL"><i class="fas fa-box" style="margin-right: 4px;"></i> -- Tampilkan Semua Box --</option>
            ${sortedBoxes.map(boxName => `<option value="${boxName}">Box: ${boxName}</option>`).join('')}
        </select>
    </div>
    <div style="margin-bottom:15px; display:flex; justify-content:space-between; align-items:center; background:#f1f5f9; padding:10px; border-radius:8px;">
        <div style="font-size:0.85rem; color:#64748b; font-weight:bold;">TOTAL CLOUD: ${totalAllPcs} PCS</div>
        <button onclick="importCloudToLocal()" style="background:var(--offbs); color:white; border:none; padding:8px 12px; border-radius:6px; cursor:pointer; font-size:0.8rem; font-weight:bold;"><i class="fas fa-download"></i> Tarik ke Sesi</button>
    </div>
    <div id="cloudBoxListContainer">`;

    sortedBoxes.forEach(box => {
        const boxData = groupedData[box]; const targetId = 'acc-' + box.replace(/[^a-zA-Z0-9]/g, '');
        html += `
        <div class="cloud-box-item" data-boxname="${box}" style="margin-bottom: 10px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
            
            <div onclick="toggleAccordion('${targetId}')" style="background: #fff7ed; padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; border-left: 5px solid var(--offbs);">
                <div style="font-weight: 800; color: #9a3412; font-size: 1rem;"><i class="fas fa-box" style="margin-right: 8px; color:var(--offbs);"></i>${box}</div>
                <div style="font-weight: bold; color: #ea580c; font-size: 0.95rem;">${boxData.totalQty} pcs</div>
            </div>

            <div id="${targetId}" style="display: none; padding: 0 15px; background: white; border-top: 1px solid #fed7aa;">`;

        boxData.items.sort((a,b) => new Date(b.time) - new Date(a.time));
        boxData.items.forEach(item => {
            let timeStr = item.time;
            try { const d = new Date(item.time); if (!isNaN(d)) timeStr = d.toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'}); } catch(e) {}
            html += `
                <div style="padding: 10px 0; border-bottom: 1px dashed #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
                    <div style="display:flex; align-items:center; flex:1; overflow:hidden;">
                        <div style="flex:1;">
                            <div style="font-weight: bold; color: var(--text); font-size: 0.95rem;">${item.partNo}</div>
                            <div style="font-size: 0.7rem; color: #64748b; font-family: monospace; margin-top:2px;">${item.docNo}</div>
                        </div>
                    </div>
                    <div style="text-align: right; margin-left:10px;">
                        <div style="font-weight: 900; color: var(--danger); font-size: 0.95rem;">${item.qty}</div>
                        <div style="font-size: 0.65rem; color: #94a3b8; margin-top:2px;">${timeStr}</div>
                    </div>
                </div>`;
        });
        html += `</div></div>`;
    });
    html += `</div>`; container.innerHTML = html;
}

window.toggleAccordion = function(id) { const content = document.getElementById(id); content.style.display = (content.style.display === 'none' || content.style.display === '') ? 'block' : 'none'; };
window.filterCloudBoxes = function(selectedBox) {
    document.querySelectorAll('.cloud-box-item').forEach(boxEl => { boxEl.style.display = (selectedBox === 'ALL' || boxEl.dataset.boxname === selectedBox) ? 'block' : 'none'; });
};

window.importCloudToLocal = function() {
    if (!lastFetchedCloudOffBs || lastFetchedCloudOffBs.length === 0) return;
    if (!confirm("Tarik data dari Cloud ke daftar 'Sesi Ini'?")) return;
    let importCount = 0;
    lastFetchedCloudOffBs.forEach(cloudItem => {
        const isDuplicate = offBsSession.some(localItem => {
            if (localItem.qr && cloudItem.qr && localItem.qr.trim() !== "" && cloudItem.qr.trim() !== "") return localItem.qr === cloudItem.qr;
            return localItem.box === cloudItem.box && localItem.partNo === cloudItem.partNo && localItem.docNo === cloudItem.docNo;
        });
        if (!isDuplicate) {
            offBsSession.push({ id: Date.now() + Math.random(), partNo: cloudItem.partNo, docNo: cloudItem.docNo, box: cloudItem.box, qty: parseInt(cloudItem.qty) || 1, qr: cloudItem.qr || "", time: cloudItem.time, synced: true });
            importCount++;
        }
    });
    localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
    offBsSession.sort((a, b) => new Date(b.time) - new Date(a.time));
    if(typeof renderOffBsList === 'function') renderOffBsList();
    document.getElementById('cloudOffBsModal').style.display = 'none';
     if(typeof showToast === 'function') showToast(importCount > 0 ? `<i class="fas fa-check-circle"></i> ${importCount} data ditarik!` : '<i class="fas fa-info-circle"></i> Semua data sudah ada.');
};

window.openOffBsFilterModal = function() {
    const uniqueBoxes = [...new Set(offBsSession.map(item => item.box))].sort();
    if (uniqueBoxes.length === 0) { if(typeof showToast === 'function') showToast("Belum ada box."); return; }
    const listContainer = document.getElementById('offBsFilterCheckboxList'); let html = '';
    uniqueBoxes.forEach(box => {
        const isChecked = !hiddenOffBsBoxes.includes(box) ? 'checked' : '';
        html += `<label style="display:flex; align-items:center; gap:10px; background:#f8fafc; padding:12px; border-radius:6px; border:1px solid #cbd5e1; cursor:pointer;"><input type="checkbox" class="filter-box-chk" value="${box}" ${isChecked} style="width:20px; height:20px;"><span style="font-weight:bold; color:#334155;">${box}</span></label>`;
    });
    listContainer.innerHTML = html; document.getElementById('offBsFilterModal').style.display = 'flex';
};

window.toggleAllOffBsFilter = function(check) { document.querySelectorAll('.filter-box-chk').forEach(chkBox => chkBox.checked = check); };
window.applyOffBsFilter = function() {
    hiddenOffBsBoxes = [];
    document.querySelectorAll('.filter-box-chk').forEach(chkBox => { if (!chkBox.checked) hiddenOffBsBoxes.push(chkBox.value); });
    document.getElementById('offBsFilterModal').style.display = 'none';
    renderOffBsList(); 
};

// Fungsi Render Khusus Tab OFF BS
function renderOffBsList() {
    const container = document.getElementById('offBsList'); if (!container) return; 
    const hiddenBoxes = typeof hiddenOffBsBoxes !== 'undefined' ? hiddenOffBsBoxes : [];
    const visibleSession = offBsSession.filter(item => !hiddenBoxes.includes(item.box));

    const totalPcs = visibleSession.reduce((sum, item) => sum + item.qty, 0);
    const unsyncedCount = visibleSession.filter(i => !i.synced).length;
    const syncWarning = unsyncedCount > 0 ? `<span style="color:var(--danger); font-size:0.8rem; margin-left:10px;">(${unsyncedCount} blm sync)</span>` : '';
    
    const countEl = document.getElementById('offBsCount');
    if (countEl) countEl.innerHTML = `${visibleSession.length} Scan (${totalPcs} pcs) ${syncWarning}`;
    
    container.innerHTML = '';
    visibleSession.forEach((item) => {
        let displayTime = item.time;
        try { const dateObj = new Date(item.time); if (!isNaN(dateObj)) displayTime = dateObj.toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'}); } catch(e) {}
        const cloudIcon = item.synced ? `<i class="fas fa-cloud-check" style="color:#16a34a; font-size:1.1rem;"></i>` : `<i class="fas fa-cloud-upload-alt" style="color:#f59e0b; font-size:1.1rem;"></i>`;

        const div = document.createElement('div');
        div.className = 'item-card'; div.style.borderLeft = '5px solid var(--offbs)';
        div.innerHTML = `
            <div style="flex:1;">
                <div style="font-weight:bold; font-size:1rem;">${item.partNo} <span style="color:var(--danger); font-size:0.85rem; margin-left:5px;">(${item.qty} pcs)</span></div>
                <div style="font-family:monospace; font-size:0.75rem; color:var(--secondary); margin-top:2px;">${item.docNo}</div>
                <div style="font-size:0.75rem; color:var(--offbs); margin-top:4px;"><i class="fas fa-box"></i> ${item.box}</div>
            </div>
            <div style="text-align:right; display:flex; flex-direction:column; align-items:flex-end; justify-content:space-between;">
                <div style="font-size:0.65rem; color:#999;">${displayTime}</div>
                <div style="margin-top:5px; margin-bottom:5px;">${cloudIcon}</div>
                <button class="btn-trash" style="width:30px; height:30px;" onclick="deleteOffBsItem(${item.id})"><i class="fas fa-trash"></i></button>
            </div>`;
        container.appendChild(div);
    });
}

// FIX: Delete Local akan otomatis Delete di Cloud jika sudah Sync
window.deleteOffBsItem = async function(id) {
    if(!confirm("Hapus scan ini? Jika part ini sudah dikirim ke Google Sheets, maka akan ikut dihapus dari sana.")) return;
    const item = offBsSession.find(i => i.id === id);
    
    offBsSession = offBsSession.filter(i => i.id !== id);
    localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
    renderOffBsList();

    if (item && item.synced) {
        try {
            await postWmsAction({ action: "delete_off_bs", data: [item] });
        } catch(e) { console.error("Gagal hapus di cloud", e); }
    }
};


// ==========================================
// LOGIKA TAB PACKING (PENGIRIMAN) - MULTI COLLY
// ==========================================
window.openAddCollyModal = function() {
    document.getElementById('addCollyNameInput').value = '';
    document.getElementById('addCollyModal').style.display = 'flex';
    document.getElementById('addCollyNameInput').focus();
};

window.closeAddCollyModal = function() {
    document.getElementById('addCollyModal').style.display = 'none';
};

window.submitAddColly = function() {
    const collyName = document.getElementById('addCollyNameInput').value.trim().toUpperCase();
    
    if (!collyName) { alert("Nama Colly tidak boleh kosong!"); return; }
    if (collyList.includes(collyName)) { alert("Nama Colly sudah ada di sesi ini!"); return; }

    collyList.push(collyName);
    localStorage.setItem('wms_colly_list', JSON.stringify(collyList));

    closeAddCollyModal();
    changeColly(collyName); // Auto set sebagai active & render real-time
};

window.changeColly = function(collyName) {
    activeColly = collyName;
    if (activeColly) {
        localStorage.setItem('wms_active_colly', activeColly);
    } else {
        localStorage.removeItem('wms_active_colly');
    }
    renderCollyUI();
    renderPackingList();
    document.getElementById('mainInput').focus();
};

window.renderCollyUI = function() {
    console.log('renderCollyUI called');
    const sel = document.getElementById('collySelect');
    if (!sel) { console.log('collySelect not found'); return; }

    if (collyList.length === 0) {
        sel.innerHTML = '<option value="">-- Belum ada Colly --</option>';
    } else {
        sel.innerHTML = '<option value="">-- Pilih Colly Tujuan --</option>';
        collyList.forEach(c => {
            const isSelected = (c === activeColly) ? 'selected' : '';
            sel.innerHTML += `<option value="${c}" ${isSelected}><i class="fas fa-box"></i> ${c}</option>`;
        });
    }

    if (activeColly) {
        const hint = document.getElementById('collyScanHint');
        if (hint) hint.innerText = activeColly;
        document.getElementById('collyScanHint').style.display = 'block';
    } else {
        document.getElementById('collyScanHint').style.display = 'none';
    }
    console.log('renderCollyUI completed');
};

window.renderPackingList = function() {
    const container = document.getElementById('packingList'); 
    if (!container) return;
    
    const totalPcs = packingSession.reduce((sum, item) => sum + item.qty, 0);
    const unsyncedCount = packingSession.filter(i => !i.synced).length;
    const syncWarning = unsyncedCount > 0 ? `<span style="color:var(--danger); font-size:0.8rem; margin-left:10px;">(${unsyncedCount} blm sync)</span>` : '';
    
    const countEl = document.getElementById('packingCount');
    if(countEl) countEl.innerHTML = `${packingSession.length} Item (${totalPcs} pcs) ${syncWarning}`;
    
    container.innerHTML = '';
    
    // Group items by colly - render semua colly dari collyList
    const collyGroups = {};
    collyList.forEach(collyName => {
        collyGroups[collyName] = [];
    });
    packingSession.forEach(item => {
        if (collyGroups[item.colly]) {
            collyGroups[item.colly].push(item);
        }
    });
    
    // Render accordion per colly
    Object.keys(collyGroups).forEach(collyName => {
        const items = collyGroups[collyName];
        const accordionId = `accordion-${collyName.replace(/[^a-zA-Z0-9]/g, '-')}`;
        const isOpen = collyName === activeColly;
        
        const accordionDiv = document.createElement('div');
        accordionDiv.style.cssText = 'border:1px solid #10b981; border-radius:8px; overflow:hidden; margin-bottom:10px; background:white;';
        
        // Header accordion
        const header = document.createElement('div');
        header.style.cssText = 'background:#f0fdf4; padding:12px 15px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; user-select:none;';
        header.onclick = () => togglePackingAccordion(accordionId);
        
        const headerLeft = document.createElement('div');
        headerLeft.style.cssText = 'display:flex; align-items:center; gap:10px; flex:1;';
        const icon = document.createElement('i');
        icon.className = isOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-right';
        icon.style.cssText = 'color:#10b981; font-weight:bold;';
        const collyLabel = document.createElement('span');
        collyLabel.style.cssText = 'font-weight:bold; color:#166534; font-size:1rem;';
        collyLabel.innerHTML = `${collyName} <span style="font-size:0.8rem; color:#6b7280;">(${items.length} item)</span>`;
        headerLeft.appendChild(icon);
        headerLeft.appendChild(collyLabel);
        
        header.appendChild(headerLeft);
        
        // Header right - delete button
        const headerRight = document.createElement('div');
        headerRight.style.cssText = 'display:flex; align-items:center;';
        const deleteBtn = document.createElement('button');
        deleteBtn.style.cssText = 'background:#fee2e2; color:#dc2626; border:none; border-radius:6px; padding:6px 10px; font-size:0.75rem; font-weight:bold; cursor:pointer; display:flex; align-items:center; gap:5px;';
        deleteBtn.innerHTML = '<i class="fas fa-trash-alt"></i>';
        deleteBtn.onclick = (e) => { e.stopPropagation(); deleteColly(collyName); };
        headerRight.appendChild(deleteBtn);
        header.appendChild(headerRight);
        
        accordionDiv.appendChild(header);
        
        // Body accordion
        const body = document.createElement('div');
        body.id = accordionId;
        body.style.cssText = `display:${isOpen ? 'block' : 'none'}; padding:10px; background:white;`;
        
        if (items.length === 0) {
            // Tampilkan pesan kosong
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'text-align:center; padding:20px; color:#9ca3af; font-size:0.9rem;';
            emptyMsg.innerHTML = '<i class="fas fa-inbox" style="font-size:1.5rem; display:block; margin-bottom:8px;"></i>Belum ada item di Colly ini';
            body.appendChild(emptyMsg);
        } else {
            // Render items
            items.forEach((item) => {
                let displayTime = item.time;
                try { const d = new Date(item.time); if (!isNaN(d)) displayTime = d.toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'}); } catch(e) {}

                const div = document.createElement('div');
                div.className = 'item-card'; 
                div.style.borderLeft = '5px solid #10b981';
                div.style.marginBottom = '8px';
                div.innerHTML = `
                    <div style="flex:1;">
                        <div style="font-weight:bold; font-size:1rem;">${item.partNo} <span style="color:var(--danger); font-size:0.85rem; margin-left:5px;">(${item.qty} pcs)</span></div>
                        <div style="font-family:monospace; font-size:0.75rem; color:var(--secondary); margin-top:2px;">${item.docNo}</div>
                        <div style="font-size:0.7rem; color:#999; margin-top:4px;">${displayTime}</div>
                    </div>
                    <div style="text-align:right;">
                        <button class="btn-trash" style="width:30px; height:30px;" onclick="deletePackingItem(${item.id})"><i class="fas fa-trash"></i></button>
                    </div>`;
                body.appendChild(div);
            });
        }
        
        accordionDiv.appendChild(body);
        container.appendChild(accordionDiv);
    });
};

window.togglePackingAccordion = function(accordionId) {
    const body = document.getElementById(accordionId);
    if (!body) return;
    
    const isOpen = body.style.display === 'block';
    
    // Close semua accordion
    const allBodies = document.querySelectorAll('[id^="accordion-"]');
    allBodies.forEach(el => {
        el.style.display = 'none';
        const header = el.previousElementSibling;
        if (header) {
            const icon = header.querySelector('i');
            if (icon) icon.className = 'fas fa-chevron-right';
        }
    });
    
    // Open accordion yang diklik (jika sebelumnya tertutup)
    if (!isOpen) {
        body.style.display = 'block';
        const header = body.previousElementSibling;
        if (header) {
            const icon = header.querySelector('i');
            if (icon) icon.className = 'fas fa-chevron-down';
            
            // Extract colly name dari header dan set sebagai active
            const collyLabel = header.querySelector('span');
            if (collyLabel) {
                const collyName = collyLabel.textContent.split(' (')[0];
                activeColly = collyName;
                localStorage.setItem('wms_active_colly', activeColly);
                renderCollyUI();
            }
        }
    }
};

window.deletePackingItem = function(id) {
    if(!confirm("Hapus scan ini?")) return;
    packingSession = packingSession.filter(i => i.id !== id);
    localStorage.setItem('wms_packing', JSON.stringify(packingSession));
    renderPackingList();
};

window.deleteColly = function(collyName) {
    if (!confirm(`Hapus Colly "${collyName}" dan semua item di dalamnya?`)) return;
    
    // Hapus colly dari list
    collyList = collyList.filter(c => c !== collyName);
    localStorage.setItem('wms_colly_list', JSON.stringify(collyList));
    
    // Hapus semua item yang ada di colly ini
    packingSession = packingSession.filter(item => item.colly !== collyName);
    localStorage.setItem('wms_packing', JSON.stringify(packingSession));
    
    // Reset active colly jika yang dihapus adalah active
    if (activeColly === collyName) {
        activeColly = collyList.length > 0 ? collyList[0] : '';
        localStorage.setItem('wms_active_colly', activeColly);
    }
    
    renderCollyUI();
    renderPackingList();
};

window.clearPackingSession = function() {
    if(packingSession.length === 0 && collyList.length === 0) return;
    if(confirm("PERINGATAN!\nMereset sesi ini akan menghapus semua daftar Colly beserta isinya dari layar. Pastikan data sudah di Export Excel!\n\nLanjutkan?")) {
        packingSession = []; localStorage.removeItem('wms_packing');
        collyList = []; localStorage.removeItem('wms_colly_list');
        activeColly = null; localStorage.removeItem('wms_active_colly');
        renderCollyUI(); renderPackingList();
    }
};

// ===== OFF BS FUNCTIONS - Fix Reset Button =====
window.clearOffBsBox = function() {
    activeOffBsBox = null;
    document.getElementById('activeOffBsBoxName').innerText = 'Belum Diset';
    feedback('success');
    showToast('Box OFF BS dihapus');
};

window.clearOffBsSession = function() {
    if(offBsSession.length === 0) { showToast("Session kosong!"); return; }
    if(confirm("PERINGATAN!\n\nMereset sesi OFF BS akan menghapus semua scan dari LAYAR LOKAL SAJA.\n\nData di Google Sheets tetap aman (bisa di-sinkronisasi ulang).\n\nLanjutkan?")) {
        // Clear local ONLY (jangan delete dari cloud)
        offBsSession = [];
        localStorage.removeItem('wms_off_bs');
        activeOffBsBox = null;
        document.getElementById('activeOffBsBoxName').innerText = 'Belum Diset';
        renderOffBsList();
        
        showToast('<i class="fas fa-check-circle"></i> Sesi OFF BS direset (local saja)');
    }
};

// ===== TWO-WAY SYNC FUNCTIONS =====

// Update favicon to show sync status
function updateFavicon(syncing) {
    const favicon = document.getElementById('favicon') || 
                    (() => { const f = document.createElement('link'); f.id = 'favicon'; f.rel = 'icon'; document.head.appendChild(f); return f; })();
    
    if (syncing) {
        // Animated favicon showing upload
        favicon.href = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle fill="%234f46e5" cx="50" cy="50" r="50"/><text x="50" y="60" font-size="60" text-anchor="middle" fill="white">↑</text></svg>';
    } else {
        // Default favicon
        favicon.href = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle fill="%2306b6d4" cx="50" cy="50" r="50"/><text x="50" y="65" font-size="50" text-anchor="middle" fill="white">W</text></svg>';
    }
}

// Two-way sync: fetch cloud data and merge with local
async function uploadToServer() {
    window.closeSyncModal?.();
    if (!requireAdminAccess('mengunggah data')) return false;
    if (!navigator.onLine) {
        updateSyncUI('<i class="fas fa-circle" style="color: #ef4444; font-size: 0.6rem; margin-right: 4px;"></i> Offline; data lokal aman');
        showToast('Tidak ada koneksi. Data lokal tetap tersimpan dan antrean upload menunggu.');
        return false;
    }
    if (isSyncing || isCloudSyncing) {
        showToast('Sinkronisasi sedang berjalan. Tunggu hingga selesai.');
        return false;
    }
    if (syncQueue.length === 0) {
        updateSyncUI('<i class="fas fa-check-circle"></i> Tidak ada antrean upload');
        showToast('Tidak ada data lokal yang menunggu upload.');
        return true;
    }

    isCloudSyncing = true;
    setSyncBusy(true);
    updateFavicon(true);
    updateSyncUI('<i class="fas fa-cloud-arrow-up"></i> Upload ke cloud sedang berjalan...');
    try {
        const success = await processSyncQueue();
        if (success) {
            updateSyncUI('<i class="fas fa-check-circle"></i> Upload berhasil');
            showToast('Upload data lokal ke server berhasil.');
        } else {
            if (pendingSyncConflicts.length > 0) {
                updateSyncUI(`<i class="fas fa-triangle-exclamation"></i> ${pendingSyncConflicts.length} konflik perlu ditinjau`);
                showToast('Upload dihentikan karena revision cloud berubah. Tinjau pilihan pada dialog konflik.');
            } else {
                updateSyncUI('<i class="fas fa-times-circle"></i> Upload gagal; data lokal aman');
                showToast('Upload gagal. Data lokal dan antrean tetap tersimpan untuk dicoba lagi.');
            }
        }
        return success;
    } catch (error) {
        console.error('Upload data lokal gagal:', error);
        updateSyncUI('<i class="fas fa-times-circle"></i> Upload gagal; data lokal aman');
        showToast(`Upload gagal: ${error.message}. Data lokal tidak dihapus.`);
        return false;
    } finally {
        isCloudSyncing = false;
        setSyncBusy(false);
        updateFavicon(false);
        if (currentTab === 'opname' && typeof handleOpnameRender === 'function') handleOpnameRender(true);
    }
}

window.manualSync = function() {
    if (!requireAdminAccess('membuka sinkronisasi')) return;
    const summary = document.getElementById('syncQueueSummary');
    if (summary) summary.textContent = `${syncQueue.length} perubahan lokal menunggu upload.`;
    document.getElementById('syncModal').style.display = 'flex';
};
window.closeSyncModal = function() {
    document.getElementById('syncModal').style.display = 'none';
};
window.uploadToServer = uploadToServer;
window.downloadFromServer = downloadFromServer;

// Cloud operations are explicit user actions; local writes continue offline.