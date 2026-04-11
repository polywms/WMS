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

// ==========================================
// FUNGSI TARIK DATA LIVE OFF BS DARI CLOUD
// ==========================================
async function fetchCloudOffBs() {
    if (!navigator.onLine) {
        showToast("Gagal: Koneksi internet terputus!");
        return;
    }

    const modal = document.getElementById('cloudOffBsModal');
    const content = document.getElementById('cloudOffBsContent');
    
    // Munculkan Modal & animasi Loading
    modal.style.display = 'flex';
    content.innerHTML = `
        <div style="text-align:center; padding:40px; color:#64748b;">
            <i class="fas fa-sync fa-spin fa-2x" style="color:var(--offbs); margin-bottom:15px;"></i>
            <div>Sedang memuat data dari Google Sheets...</div>
        </div>`;

    try {
        const response = await fetch(API_URL, {
            method: "POST",
            redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "get_cloud_off_bs" })
        });

        const result = await response.json();

        if (result.status === "success") {
            renderCloudAccordion(result.data);
        } else {
            content.innerHTML = `<div style="color:var(--danger); text-align:center; padding:20px;">Gagal: ${result.message}</div>`;
        }
    } catch (err) {
        console.error(err);
        content.innerHTML = `<div style="color:var(--danger); text-align:center; padding:20px;"><i class="fas fa-exclamation-triangle fa-2x"></i><br><br>Gagal terhubung ke Server Cloud.</div>`;
    }
}

// Fungsi untuk merender UI Accordion
function renderCloudAccordion(data) {
    const container = document.getElementById('cloudOffBsContent');

    // Filter data kosong
    const validData = data.filter(item => item.box && item.partNo);

    if (validData.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px; color:#94a3b8;">
                <i class="fas fa-box-open fa-3x" style="margin-bottom:15px; opacity:0.5;"></i>
                <div>Database kosong. Belum ada part OFF BS yang tersimpan di Cloud.</div>
            </div>`;
        return;
    }

    // 1. KELOMPOKKAN DATA BERDASARKAN BOX
    const groupedData = {};
    let totalAllPcs = 0;

    validData.forEach(item => {
        const boxName = item.box.trim().toUpperCase();
        if (!groupedData[boxName]) {
            groupedData[boxName] = { totalQty: 0, items: [] };
        }
        const qty = parseInt(item.qty) || 0;
        groupedData[boxName].totalQty += qty;
        groupedData[boxName].items.push(item);
        totalAllPcs += qty;
    });

    // 2. RENDER HTML
    let html = `<div style="margin-bottom:15px; text-align:center; font-size:0.85rem; color:#64748b; font-weight:bold;">TOTAL GLOBAL: ${totalAllPcs} PCS</div>`;

    // Sort nama box secara alfabet (misal RTF-01 di atas RTF-02)
    const sortedBoxes = Object.keys(groupedData).sort();

    sortedBoxes.forEach(box => {
        const boxData = groupedData[box];
        // Buat ID unik tanpa spasi/simbol untuk target Accordion HTML
        const targetId = 'acc-' + box.replace(/[^a-zA-Z0-9]/g, '');

        html += `
        <div style="margin-bottom: 10px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
            
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

        // Urutkan part berdasarkan waktu scan (terbaru di atas)
        boxData.items.sort((a,b) => new Date(b.time) - new Date(a.time));

        boxData.items.forEach(item => {
            // Rapikan format jam
            let timeStr = item.time;
            try {
                const dateObj = new Date(item.time);
                if (!isNaN(dateObj)) timeStr = dateObj.toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'});
            } catch(e) {}

            html += `
                <div style="padding: 10px 0; border-bottom: 1px dashed #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
                    <div style="flex:1; padding-right:10px;">
                        <div style="font-weight: bold; color: var(--text); font-size: 0.95rem;">${item.partNo}</div>
                        <div style="font-size: 0.7rem; color: #64748b; font-family: monospace; margin-top:2px;">${item.docNo}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-weight: 900; color: var(--danger); font-size: 0.95rem;">${item.qty}</div>
                        <div style="font-size: 0.65rem; color: #94a3b8; margin-top:2px;">${timeStr}</div>
                    </div>
                </div>
            `;
        });

        html += `
            </div> </div> `;
    });

    container.innerHTML = html;
}

// Fungsi kecil untuk animasi buka/tutup Accordion
window.toggleAccordion = function(id) {
    const content = document.getElementById(id);
    const icon = document.getElementById('icon-' + id);
    if (content.style.display === 'none' || content.style.display === '') {
        content.style.display = 'block';
        icon.style.transform = 'rotate(180deg)';
    } else {
        content.style.display = 'none';
        icon.style.transform = 'rotate(0deg)';
    }
};

setInterval(() => {
    processSyncQueue(); // Sync data WMS biasa
    triggerOffBsSync(); // Sync data OFF BS
}, 5000);