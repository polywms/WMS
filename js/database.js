// js/database.js
function updateSyncUI(text) {
    const el = document.getElementById('syncStatus');
    if(el) el.innerText = text;
}

function initDB() {
    return new Promise(resolve => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('items', { keyPath: 'id' });
        req.onsuccess = e => { db = e.target.result; fetchInitialDataFromCloud().then(resolve); };
    });
}

function loadDataFromLocal() {
    const tx = db.transaction('items', 'readonly');
    tx.objectStore('items').getAll().onsuccess = e => {
        localItems = e.target.result || [];
        localItems.forEach(i => { if(!i.locations) i.locations = {}; });
        localItems.sort((a,b) => a.partNo.localeCompare(b.partNo));
        populateFilters();
        if(currentTab === 'opname') handleOpnameRender();
        if(currentTab === 'simpan') renderSimpanList(true);
        if(currentTab === 'data') renderDataList(true);
    };
}

async function fetchInitialDataFromCloud() {
    if (!navigator.onLine) {
        updateSyncUI("🔴 Offline (Mode Lokal)");
        loadDataFromLocal();
        return;
    }
    updateSyncUI("🟡 Menghubungkan ke Database...");
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); 
        const response = await fetch(API_URL, { redirect: "follow", signal: controller.signal });
        clearTimeout(timeoutId); 
        updateSyncUI("🔄 Menerima Data...");
        const result = await response.json();
        
        if (result.status === "success") {
            const dataCount = result.data.length;
            if (dataCount > 0) {
                updateSyncUI(`🔄 Memproses ${dataCount} Item...`);
                const tx = db.transaction('items', 'readwrite');
                const store = tx.objectStore('items');
                store.clear(); 
                result.data.forEach(item => store.add(item)); 
                tx.oncomplete = () => {
                    updateSyncUI("🟢 Tersambung & Update");
                    loadDataFromLocal(); 
                    setTimeout(() => updateSyncUI("🟢 Online"), 3000); 
                };
            } else {
                updateSyncUI("🟢 Database Kosong");
                loadDataFromLocal();
                setTimeout(() => updateSyncUI("🟢 Online"), 3000);
            }
        } else {
            console.error("Error dari Apps Script:", result.message);
            updateSyncUI("🔴 Gagal (Error Script)");
            loadDataFromLocal();
        }
    } catch (error) {
        console.error("Gagal narik data:", error);
        if (error.name === 'AbortError') updateSyncUI("🔴 Timeout (Server Lama)");
        else updateSyncUI("🔴 Gagal Terhubung (Cek API)");
        loadDataFromLocal(); 
    }
}

function saveDB(item, actionName = "UPDATE", actionDetail = "") {
    const tx = db.transaction('items', 'readwrite');
    tx.objectStore('items').put(item);
    syncQueue.push(item);
    syncLogs.push({ partNo: item.partNo, action: actionName, detail: actionDetail || "Update Qty/Lokasi" });
    updateSyncUI("🟡 Menunggu Sync...");
}

async function processSyncQueue() {
    if (isSyncing || (syncQueue.length === 0 && syncLogs.length === 0) || !navigator.onLine) return;
    isSyncing = true;
    updateSyncUI("🔄 Syncing...");
    try {
        const uniqueItemsMap = {};
        syncQueue.forEach(item => uniqueItemsMap[item.id] = item);
        const itemsToSync = Object.values(uniqueItemsMap);
        const payload = { action: "sync", data: itemsToSync, logs: syncLogs };
        
        const response = await fetch(API_URL, {
            method: "POST", redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        
        if (result.status === "success") {
            syncQueue = []; syncLogs = [];
            updateSyncUI("🟢 Tersimpan");
        } else {
            updateSyncUI("🔴 Gagal Sync");
        }
    } catch (error) {
        console.error("Sync error:", error);
        updateSyncUI("🔴 Offline");
    } finally {
        isSyncing = false;
    }
}
setInterval(() => {
    processSyncQueue(); // Sync data WMS biasa
    triggerOffBsSync(); // Sync data OFF BS
}, 5000);