// js/database.js

let lastFetchedCloudOffBs = [];
let hiddenOffBsBoxes = [];

// Variabel TAB PACKING
let packingSession = JSON.parse(localStorage.getItem('wms_packing')) || [];
let collyList = JSON.parse(localStorage.getItem('wms_colly_list')) || [];
let activeColly = localStorage.getItem('wms_active_colly') || null;

function updateSyncUI(text) { const el = document.getElementById('syncStatus'); if(el) el.innerText = text; }

function initDB() {
    return new Promise(resolve => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('items', { keyPath: 'id' });
        req.onsuccess = e => { 
            db = e.target.result; 
            fetchInitialDataFromCloud().then(resolve); 
        };
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
    if (!navigator.onLine) { updateSyncUI("🔴 Offline (Mode Lokal)"); loadDataFromLocal(); return; }
    updateSyncUI("🟡 Menghubungkan ke Database...");
    try {
        const controller = new AbortController(); const timeoutId = setTimeout(() => controller.abort(), 30000); 
        const response = await fetch(API_URL, { redirect: "follow", signal: controller.signal }); clearTimeout(timeoutId); 
        updateSyncUI("🔄 Menerima Data..."); const result = await response.json();
        
        if (result.status === "success") {
            if (result.data && Array.isArray(result.data)) {
                if (result.data.length > 0) {
                    updateSyncUI(`🔄 Memproses ${result.data.length} Item...`);
                    const tx = db.transaction('items', 'readwrite'); const store = tx.objectStore('items');
                    store.clear(); result.data.forEach(item => store.add(item)); 
                    tx.oncomplete = () => { updateSyncUI("🟢 Tersambung & Update"); loadDataFromLocal(); setTimeout(() => updateSyncUI("🟢 Online"), 3000); };
                } else { updateSyncUI("🟢 Database Kosong"); loadDataFromLocal(); setTimeout(() => updateSyncUI("🟢 Online"), 3000); }
            } else { updateSyncUI("🔴 Gagal (Data Rusak)"); loadDataFromLocal(); }
        } else { updateSyncUI("🔴 Gagal (Error Script)"); loadDataFromLocal(); }
    } catch (error) {
        if (error.name === 'AbortError') updateSyncUI("🔴 Timeout (Server Lambat)"); else updateSyncUI("🔴 Gagal Terhubung (Cek API)");
        loadDataFromLocal(); 
    }
}

function saveDB(item, actionName = "UPDATE", actionDetail = "") {
    const tx = db.transaction('items', 'readwrite'); tx.objectStore('items').put(item);
    syncQueue.push(item); syncLogs.push({ partNo: item.partNo, action: actionName, detail: actionDetail || "Update Qty/Lokasi" });
    updateSyncUI("🟡 Menunggu Sync...");
}

async function processSyncQueue() {
    if (isSyncing || (syncQueue.length === 0 && syncLogs.length === 0) || !navigator.onLine) return;
    isSyncing = true; updateSyncUI("🔄 Syncing...");
    try {
        const uniqueItemsMap = {}; syncQueue.forEach(item => uniqueItemsMap[item.id] = item);
        const payload = { action: "sync", data: Object.values(uniqueItemsMap), logs: syncLogs };
        const response = await fetch(API_URL, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) });
        const result = await response.json();
        if (result.status === "success") { syncQueue = []; syncLogs = []; updateSyncUI("🟢 Tersimpan"); } else { updateSyncUI("🔴 Gagal Sync"); }
    } catch (error) { updateSyncUI("🔴 Offline"); } finally { isSyncing = false; }
}

async function triggerOffBsSync() {
    if (!navigator.onLine || isSyncing || typeof offBsSession === 'undefined') return;
    const unsyncedData = offBsSession.filter(i => !i.synced); if (unsyncedData.length === 0) return; 
    isSyncing = true; updateSyncUI("🔄 Syncing OFF BS...");
    try {
        const response = await fetch(API_URL, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "sync_off_bs", data: unsyncedData }) });
        const result = await response.json();
        if (result.status === "success") {
            unsyncedData.forEach(u => u.synced = true); localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
            updateSyncUI("🟢 OFF BS Tersimpan");
            if(currentTab === 'offbs') renderOffBsList(); 
            if (result.duplicates > 0) alert(`⚠️ PERINGATAN SINKRONISASI!\n\n${result.duplicates} data ditolak oleh Cloud karena part dan dokumen sudah masuk Database sebelumnya.\n\nPart ditolak:\n${result.duplicateParts.join(', ')}`);
        } else { updateSyncUI("🔴 Gagal Sync OFF BS"); }
    } catch (err) { updateSyncUI("🔴 Offline"); } finally { isSyncing = false; }
}

async function fetchCloudOffBs() {
    if (!navigator.onLine) { if(typeof showToast === 'function') showToast("Gagal: Koneksi internet terputus!"); return; }
    const modal = document.getElementById('cloudOffBsModal'); const content = document.getElementById('cloudOffBsContent');
    modal.style.display = 'flex';
    content.innerHTML = `<div style="text-align:center; padding:40px; color:#64748b;"><i class="fas fa-sync fa-spin fa-2x" style="color:var(--offbs); margin-bottom:15px;"></i><div>Sedang memuat data dari Google Sheets...</div></div>`;
    try {
        const response = await fetch(API_URL, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "get_cloud_off_bs" }) });
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
            <option value="ALL">📦 -- Tampilkan Semua Box --</option>
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
    if(typeof showToast === 'function') showToast(importCount > 0 ? `✅ ${importCount} data ditarik!` : "ℹ️ Semua data sudah ada.");
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
            await fetch(API_URL, {
                method: "POST", redirect: "follow",
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify({ action: "delete_off_bs", data: [item] })
            });
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
            sel.innerHTML += `<option value="${c}" ${isSelected}>📦 ${c}</option>`;
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

window.triggerPackingSync = async function() {
    if (!navigator.onLine || typeof packingSession === 'undefined') return;
    const unsyncedData = packingSession.filter(i => !i.synced); if (unsyncedData.length === 0) return; 
    try {
        const response = await fetch(API_URL, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "sync_packing", data: unsyncedData }) });
        const result = await response.json();
        if (result.status === "success") {
            unsyncedData.forEach(u => u.synced = true); localStorage.setItem('wms_packing', JSON.stringify(packingSession));
            if(currentTab === 'packing') renderPackingList();
        }
    } catch (err) { console.error(err); }
};

setInterval(() => {
    processSyncQueue();
    if(typeof triggerOffBsSync === 'function') triggerOffBsSync();
    if(typeof triggerPackingSync === 'function') triggerPackingSync();
}, 5000);