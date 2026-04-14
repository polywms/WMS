// js/database.js

let lastFetchedCloudOffBs = [];
let hiddenOffBsBoxes = [];

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
        if(typeof populateFilters === 'function') populateFilters();
        if(currentTab === 'opname' && typeof handleOpnameRender === 'function') handleOpnameRender();
        if(currentTab === 'simpan' && typeof renderSimpanList === 'function') renderSimpanList(true);
        if(currentTab === 'data' && typeof renderDataList === 'function') renderDataList(true);
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
        const timeoutId = setTimeout(() => controller.abort(), 30000); 
        
        const response = await fetch(API_URL, { redirect: "follow", signal: controller.signal });
        clearTimeout(timeoutId); 
        
        updateSyncUI("🔄 Menerima Data...");
        const result = await response.json();
        
        if (result.status === "success") {
            if (result.data && Array.isArray(result.data)) {
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
                console.error("Format data dari server tidak valid", result);
                updateSyncUI("🔴 Gagal (Data Rusak)");
                loadDataFromLocal();
            }
            
        } else {
            console.error("Error dari Apps Script:", result.message);
            updateSyncUI("🔴 Gagal (Error Script)");
            loadDataFromLocal();
        }
    } catch (error) {
        console.error("Gagal narik data:", error);
        if (error.name === 'AbortError') {
            updateSyncUI("🔴 Timeout (Server Lambat)");
        } else {
            updateSyncUI("🔴 Gagal Terhubung (Cek API)");
        }
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

// ==========================================
// FUNGSI SINKRONISASI OFF BS (KE CLOUD)
// ==========================================
async function triggerOffBsSync() {
    // Jangan sync jika internet mati, proses lain berjalan, atau tidak ada data sesi
    if (!navigator.onLine || isSyncing || typeof offBsSession === 'undefined') return;

    // Filter hanya data yang belum ter-sync
    const unsyncedData = offBsSession.filter(i => !i.synced);
    if (unsyncedData.length === 0) return; 

    isSyncing = true;
    updateSyncUI("🔄 Syncing OFF BS...");

    try {
        const payload = {
            action: "sync_off_bs",
            data: unsyncedData
        };

        const response = await fetch(API_URL, {
            method: "POST", redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.status === "success") {
            // Ubah bendera synced menjadi true
            unsyncedData.forEach(u => u.synced = true);
            localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
            
            updateSyncUI("🟢 OFF BS Tersimpan");
            if(typeof currentTab !== 'undefined' && currentTab === 'offbs' && typeof renderOffBsList === 'function') {
                renderOffBsList(); // Segarkan ikon awan di layar
            }
            
            // POPUP PERINGATAN DUPLIKAT DARI CLOUD
            if (result.duplicates && result.duplicates > 0) {
                alert(`⚠️ PERINGATAN SINKRONISASI!\n\nSebanyak ${result.duplicates} data ditolak oleh Cloud karena part dan dokumen (SJOB) ini sudah pernah masuk ke Database sebelumnya.\n\nPart yang ditolak (Duplikat):\n${result.duplicateParts.join(', ')}`);
            }
            
        } else {
            updateSyncUI("🔴 Gagal Sync OFF BS");
        }
    } catch (err) {
        console.error("Gagal sync OFF BS:", err);
        updateSyncUI("🔴 Offline");
    } finally {
        isSyncing = false;
    }
}

// ==========================================
// FUNGSI TARIK DATA LIVE OFF BS DARI CLOUD
// ==========================================
async function fetchCloudOffBs() {
    if (!navigator.onLine) {
        if(typeof showToast === 'function') showToast("Gagal: Koneksi internet terputus!");
        return;
    }

    const modal = document.getElementById('cloudOffBsModal');
    const content = document.getElementById('cloudOffBsContent');
    
    modal.style.display = 'flex';
    content.innerHTML = `
        <div style="text-align:center; padding:40px; color:#64748b;">
            <i class="fas fa-sync fa-spin fa-2x" style="color:var(--offbs); margin-bottom:15px;"></i>
            <div>Sedang memuat data dari Google Sheets...</div>
        </div>`;

    try {
        const response = await fetch(API_URL, {
            method: "POST", redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "get_cloud_off_bs" })
        });

        const result = await response.json();

        if (result.status === "success") {
            if (result.data && Array.isArray(result.data)) {
                lastFetchedCloudOffBs = result.data; 
                renderCloudAccordion(result.data);
            } else {
                content.innerHTML = `<div style="color:var(--danger); text-align:center; padding:20px;">
                    <b>Data Tidak Valid!</b><br><br>Google Script versi lama terdeteksi.<br>Pastikan kamu sudah melakukan "Deploy -> New Version" di Code.gs!
                </div>`;
            }
        } else {
            content.innerHTML = `<div style="color:var(--danger); text-align:center; padding:20px;">Gagal: ${result.message}</div>`;
        }
    } catch (err) {
        console.error(err);
        content.innerHTML = `<div style="color:var(--danger); text-align:center; padding:20px;"><i class="fas fa-exclamation-triangle fa-2x"></i><br><br>Gagal terhubung ke Server Cloud.</div>`;
    }
}

// Fungsi untuk merender UI Accordion (+ Fitur Filter Box)
function renderCloudAccordion(data) {
    const container = document.getElementById('cloudOffBsContent');
    const validData = data.filter(item => item.box && item.partNo);

    if (validData.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px; color:#94a3b8;">
                <i class="fas fa-box-open fa-3x" style="margin-bottom:15px; opacity:0.5;"></i>
                <div>Database kosong. Belum ada part OFF BS yang tersimpan di Cloud.</div>
            </div>`;
        return;
    }

    const groupedData = {};
    let totalAllPcs = 0;

    validData.forEach(item => {
        const boxName = item.box.trim().toUpperCase();
        if (!groupedData[boxName]) groupedData[boxName] = { totalQty: 0, items: [] };
        const qty = parseInt(item.qty) || 0;
        groupedData[boxName].totalQty += qty;
        groupedData[boxName].items.push(item);
        totalAllPcs += qty;
    });

    const sortedBoxes = Object.keys(groupedData).sort();

    // 1. TAMBAHAN: Buat Dropdown Filter Box
    let html = `
    <div style="margin-bottom: 15px;">
        <select id="cloudBoxFilter" onchange="filterCloudBoxes(this.value)" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid #cbd5e1; font-weight:bold; color:var(--text); background:white; font-size:0.9rem; outline:none; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
            <option value="ALL">📦 -- Tampilkan Semua Box --</option>
            ${sortedBoxes.map(boxName => `<option value="${boxName}">Box: ${boxName}</option>`).join('')}
        </select>
    </div>

    <div style="margin-bottom:15px; display:flex; justify-content:space-between; align-items:center; background:#f1f5f9; padding:10px; border-radius:8px;">
        <div style="font-size:0.85rem; color:#64748b; font-weight:bold;">TOTAL CLOUD: ${totalAllPcs} PCS</div>
        <button onclick="importCloudToLocal()" style="background:var(--offbs); color:white; border:none; padding:8px 12px; border-radius:6px; cursor:pointer; font-size:0.8rem; font-weight:bold;">
            <i class="fas fa-download"></i> Tarik ke Sesi
        </button>
    </div>
    
    <div id="cloudBoxListContainer">
    `;

    sortedBoxes.forEach(box => {
        const boxData = groupedData[box];
        const targetId = 'acc-' + box.replace(/[^a-zA-Z0-9]/g, '');

        // TAMBAHAN: Masukkan class 'cloud-box-item' dan data-boxname agar bisa difilter oleh Javascript
        html += `
        <div class="cloud-box-item" data-boxname="${box}" style="margin-bottom: 10px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
            <div onclick="toggleAccordion('${targetId}')" style="background: #fff7ed; padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; border-left: 5px solid var(--offbs);">
                <div style="font-weight: 800; color: #9a3412; font-size: 1rem;">
                    <i class="fas fa-box" style="margin-right: 8px; color:var(--offbs);"></i>${box}
                </div>
                <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="background: var(--offbs); color: white; padding: 3px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold;">${boxData.totalQty} pcs</span>
                    <i class="fas fa-chevron-down" id="icon-${targetId}" style="color: #ea580c; transition: transform 0.3s ease;"></i>
                </div>
            </div>

            <div id="${targetId}" style="display: none; padding: 0 15px; background: white; border-top: 1px solid #fed7aa;">
        `;

        boxData.items.sort((a,b) => new Date(b.time) - new Date(a.time));

        boxData.items.forEach(item => {
            let timeStr = item.time;
            try {
                const dateObj = new Date(item.time);
                if (!isNaN(dateObj)) timeStr = dateObj.toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'});
            } catch(e) {}

            html += `
                <div style="padding: 10px 0; border-bottom: 1px dashed #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
                    <div style="display:flex; align-items:center; flex:1; overflow:hidden;">
                        <input type="checkbox" class="chk-checkout-${targetId}" data-box="${item.box}" data-part="${item.partNo}" data-doc="${item.docNo}" style="width:18px; height:18px; cursor:pointer; margin-right:12px;">
                        <div style="flex:1;">
                            <div style="font-weight: bold; color: var(--text); font-size: 0.95rem;">${item.partNo}</div>
                            <div style="font-size: 0.7rem; color: #64748b; font-family: monospace; margin-top:2px;">${item.docNo}</div>
                        </div>
                    </div>
                    <div style="text-align: right; margin-left:10px;">
                        <div style="font-weight: 900; color: var(--danger); font-size: 0.95rem;">${item.qty}</div>
                        <div style="font-size: 0.65rem; color: #94a3b8; margin-top:2px;">${timeStr}</div>
                    </div>
                </div>
            `;
        });

        html += `
                <div style="padding: 12px 0; display:flex; justify-content:space-between; align-items:center; background: #fafaf9; margin: 0 -15px; padding: 10px 15px;">
                    <label style="font-size:0.85rem; font-weight:bold; cursor:pointer; color:var(--secondary); display:flex; align-items:center; gap:8px;">
                        <input type="checkbox" onchange="toggleAllCheckboxes('${targetId}', this.checked)" style="width:16px; height:16px;"> Pilih Semua
                    </label>
                    <button onclick="checkoutBox(event, '${targetId}')" style="background:#10b981; color:white; border:none; padding:8px 16px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:0.85rem; box-shadow:0 2px 4px rgba(16,185,129,0.3); display:flex; align-items:center; gap:6px;">
                        <i class="fas fa-truck"></i> Kirim ke Pusat
                    </button>
                </div>
            </div> 
        </div> 
        `;
    });

    html += `</div>`; // Tutup container list
    container.innerHTML = html;
}

// 2. TAMBAHAN BARU: Fungsi untuk menyembunyikan/menampilkan Box sesuai pilihan Dropdown
window.filterCloudBoxes = function(selectedBox) {
    const allBoxes = document.querySelectorAll('.cloud-box-item');
    allBoxes.forEach(boxEl => {
        if (selectedBox === 'ALL' || boxEl.dataset.boxname === selectedBox) {
            boxEl.style.display = 'block';
        } else {
            boxEl.style.display = 'none';
        }
    });
};

// Pastikan fungsi ini dan fungsi checkoutBox(...) yang lama tetap ada di bawahnya ya!
// Fungsi Bantuan Checkbox "Pilih Semua"
window.toggleAllCheckboxes = function(targetId, isChecked) {
    document.querySelectorAll(`.chk-checkout-${targetId}`).forEach(chk => {
        chk.checked = isChecked;
    });
};

// ==========================================
// FUNGSI CHECKOUT / KIRIM KE PUSAT
// ==========================================
window.checkoutBox = async function(event, targetId) {
    const checkboxes = document.querySelectorAll(`.chk-checkout-${targetId}:checked`);
    
    if (checkboxes.length === 0) {
        alert("Pilih minimal 1 part dengan mencentang kotaknya untuk dikirim ke Pusat!");
        return;
    }

    if (!confirm(`Truk siap berangkat! 🚚\n\nKamu akan mengirim ${checkboxes.length} part ke Pusat.\nPart ini akan dipindah ke arsip (HISTORY) dan dihapus dari layar ini.\n\nLanjutkan?`)) return;

    // Ambil data dari attribute HTML checkbox yang dicentang
    const itemsToCheckout = Array.from(checkboxes).map(chk => ({
        box: chk.dataset.box,
        partNo: chk.dataset.part,
        docNo: chk.dataset.doc
    }));

    // Ubah tombol jadi loading
    const btn = event.currentTarget;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Mengirim...`;
    btn.disabled = true;
    btn.style.opacity = '0.7';

    try {
        const response = await fetch(API_URL, {
            method: "POST", redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "checkout_off_bs", data: itemsToCheckout })
        });
        const result = await response.json();

        if (result.status === "success") {
            alert(`✅ SUKSES!\n${result.message}`);
            fetchCloudOffBs(); // Refresh modal otomatis biar part yang dikirim hilang dari layar
        } else {
            alert(`❌ Gagal: ${result.message}`);
            btn.innerHTML = originalHTML;
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    } catch (err) {
        console.error(err);
        alert("Gagal terhubung ke server. Pastikan internet stabil.");
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        btn.style.opacity = '1';
    }
};

// ==========================================
// FUNGSI IMPORT CLOUD KE LOKAL SESI OFF BS
// ==========================================
window.importCloudToLocal = function() {
    if (!lastFetchedCloudOffBs || lastFetchedCloudOffBs.length === 0) return;

    if (!confirm("Tarik data dari Cloud ke daftar 'Sesi Ini'?\n\nCatatan: Data yang ditarik tidak akan duplikat dengan yang sudah ada di layar.")) return;

    let importCount = 0;

    lastFetchedCloudOffBs.forEach(cloudItem => {
        const isDuplicate = offBsSession.some(localItem => localItem.qr === cloudItem.qr);
        
        if (!isDuplicate) {
            offBsSession.push({
                id: Date.now() + Math.random(), 
                partNo: cloudItem.partNo,
                docNo: cloudItem.docNo,
                box: cloudItem.box,
                qty: parseInt(cloudItem.qty) || 1,
                qr: cloudItem.qr,
                time: cloudItem.time,
                synced: true 
            });
            importCount++;
        }
    });

    localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
    
    offBsSession.sort((a, b) => new Date(b.time) - new Date(a.time));
    
    if(typeof renderOffBsList === 'function') renderOffBsList();

    document.getElementById('cloudOffBsModal').style.display = 'none';
    
    if(typeof showToast === 'function') {
        if (importCount > 0) {
            showToast(`✅ ${importCount} data Cloud ditarik ke lokal!`);
        } else {
            showToast("ℹ️ Semua data sudah ada di lokal (Tidak ada data baru).");
        }
    }
};


// ==========================================
// FUNGSI MODAL FILTER BOX (SESI LOKAL)
// ==========================================
window.openOffBsFilterModal = function() {
    // Ambil daftar nama box unik dari sesi
    const uniqueBoxes = [...new Set(offBsSession.map(item => item.box))].sort();
    
    if (uniqueBoxes.length === 0) {
        if(typeof showToast === 'function') showToast("Belum ada box di sesi ini.");
        return;
    }

    const listContainer = document.getElementById('offBsFilterCheckboxList');
    let html = '';
    
    uniqueBoxes.forEach(box => {
        // Centang by default, KECUALI box ini ada di dalam hiddenOffBsBoxes
        const isChecked = !hiddenOffBsBoxes.includes(box) ? 'checked' : '';
        html += `
            <label style="display:flex; align-items:center; gap:10px; background:#f8fafc; padding:12px; border-radius:6px; border:1px solid #cbd5e1; cursor:pointer;">
                <input type="checkbox" class="filter-box-chk" value="${box}" ${isChecked} style="width:20px; height:20px;">
                <span style="font-weight:bold; color:#334155; font-size:0.95rem;">${box}</span>
            </label>
        `;
    });
    
    listContainer.innerHTML = html;
    document.getElementById('offBsFilterModal').style.display = 'flex';
};

window.toggleAllOffBsFilter = function(check) {
    document.querySelectorAll('.filter-box-chk').forEach(chkBox => {
        chkBox.checked = check;
    });
};

window.applyOffBsFilter = function() {
    hiddenOffBsBoxes = []; // Kosongkan dulu
    
    // Cari mana saja checkbox yang TIDAK dicentang, lalu masukkan ke daftar sembunyi
    document.querySelectorAll('.filter-box-chk').forEach(chkBox => {
        if (!chkBox.checked) {
            hiddenOffBsBoxes.push(chkBox.value);
        }
    });
    
    document.getElementById('offBsFilterModal').style.display = 'none';
    renderOffBsList(); // Refresh UI
};
// Interval Utama Aplikasi
setInterval(() => {
    processSyncQueue(); // Sync data WMS biasa
    if(typeof triggerOffBsSync === 'function') triggerOffBsSync(); // Sync data OFF BS
}, 5000);
