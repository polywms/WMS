// js/core.js

// ==========================================
// 1. FILTER & PENGATURAN MODE INPUT
// ==========================================
function populateFilters() {
    const locs = [...new Set(localItems.map(i => i.locType))].filter(Boolean).sort();
    const selLoc = document.getElementById('filterLoc');
    selLoc.innerHTML = '<option value="">-- Pilih Lokasi --</option>';
    locs.forEach(l => selLoc.innerHTML += `<option value="${l}">${l}</option>`);
    
    const techs = [...new Set(localItems.map(i => i.techName))].filter(Boolean).sort();
    const selTech = document.getElementById('filterTech');
    selTech.innerHTML = '<option value="">-- Teknisi --</option>';
    techs.forEach(t => selTech.innerHTML += `<option value="${t}">${t}</option>`);
}

function handleFilterChange() {
    const loc = document.getElementById('filterLoc').value;
    const tech = document.getElementById('filterTech').value;
    document.getElementById('filterTech').style.display = loc.toUpperCase().includes('TEKNISI') ? 'block' : 'none';
    
    if (!loc) filteredItems = [];
    else filteredItems = localItems.filter(i => {
        let m = i.locType === loc;
        if(m && loc.toUpperCase().includes('TEKNISI') && tech) m = i.techName === tech;
        return m;
    });
    
    clearActivePart();
    clearMultiBuffer();
    clearOpnameBoxFilter();
    handleOpnameRender();
    renderSimpanList(true);
    renderDataList(true);
    document.getElementById('mainInput').focus();
}

function handleInputKeyDown(e) {
    if(e.key === 'Enter') {
        const val = e.target.value; 
        e.target.value = '';
        if(val) processScan(val);
    }
}

function toggleKeyboardMode() {
    const chk = document.getElementById('chkManualType');
    const input = document.getElementById('mainInput');
    if(chk.checked) {
        input.setAttribute('inputmode', 'text');
        input.placeholder = "Ketik Manual...";
    } else {
        input.setAttribute('inputmode', 'none');
        input.placeholder = "Scan Part / Box...";
    }
    input.focus();
}

function toggleMultiMode() {
    isMultiScan = document.getElementById('chkMultiScan').checked;
    const root = document.documentElement;
    document.getElementById('simpanStatusPanel').style.display = isMultiScan ? 'none' : 'none'; 
    document.getElementById('multiScanPanel').style.display = isMultiScan ? 'block' : 'none';
    document.getElementById('filterNoBoxToggle').style.display = isMultiScan ? 'flex' : 'none';
    
    if (isMultiScan) {
        clearActivePart();
        root.style.setProperty('--active-color', 'var(--purple)');
        document.querySelector('header').style.background = 'var(--purple)';
        setStatus("Mode Multi Scan Aktif");
        renderMultiBuffer(); 
    } else {
        clearMultiBuffer();
        root.style.setProperty('--active-color', 'var(--primary)');
        document.querySelector('header').style.background = 'var(--primary)';
        setStatus("Mode Single Scan");
    }
    document.getElementById('mainInput').focus();
}

// ==========================================
// 2. LOGIKA UTAMA: PROCESS SCAN
// ==========================================
function processScan(code) {
    let rawCode = code.trim().toUpperCase();
    let parsedCode = rawCode.includes('|') ? rawCode.split('|')[0] : rawCode;

    addToHistory(parsedCode);

    const boxPattern = /^[A-Z][0-9]{0,2}-[0-9]{2,3}$/;
    const isBox = boxPattern.test(rawCode);

    // ==========================================
    // LOGIKA KHUSUS TAB OFF BS
    // ==========================================
    if (currentTab === 'offbs') {
        // Cek apakah yang discan adalah Box berawalan RTF
        if (rawCode.startsWith('RTF')) {
            activeOffBsBox = rawCode;
            document.getElementById('activeOffBsBoxName').innerText = rawCode;
            feedback('scan');
            showToast(`Box OFF BS Aktif: ${rawCode}`);
            return;
        }

        if (!activeOffBsBox) {
            feedback('error');
            showToast("TOLAKAN: Scan Box Tujuan (RTF) dulu!");
            return;
        }

        // Cegah scan box reguler
        if (isBox && !rawCode.startsWith('RTF')) {
            feedback('error');
            alert(`TOLAKAN!\n\nIni adalah box reguler (${rawCode}).\nUntuk barang bekas, kamu harus menggunakan box berawalan RTF!`);
            return;
        }

        // Parser QR Bekas
        if (!rawCode.includes('|')) {
            feedback('error');
            showToast("TOLAKAN: Format QR bukan bekas/SJOB!");
            return;
        }

        const parts = rawCode.split('|');
        const partNo = parts[0].trim();
        // BACA QTY DARI QR (Ambil elemen ke-2 setelah | pertama. Default 1 jika kosong/huruf)
        const scanQty = parseInt(parts[1]) || 1; 
        const docNo = parts[3] ? parts[3].trim() : "TIDAK ADA DOC"; 

        // Validasi DB Master: Harus ada di DB dan tipenya OFF BS
        const masterItem = localItems.find(i => i.partNo === partNo && (i.locType || '').toUpperCase().includes('OFF BS'));
        
        if (!masterItem) {
            feedback('error');
            alert(`TOLAKAN:\nPart ${partNo} tidak terdaftar sebagai SPAREPART OFF BS di Database Master!`);
            return;
        }

        // Hitung total QTY yang sudah di-scan (Bukan jumlah baris, tapi jumlah QTY-nya)
        const currentTotalQty = offBsSession
            .filter(i => i.partNo === partNo)
            .reduce((sum, item) => sum + item.qty, 0);

        // Cek apakah menambah QTY ini akan membuat stok Over
        if ((currentTotalQty + scanQty) > masterItem.sysQty) {
            feedback('error');
            alert(`OVER QTY!\n\nPart: ${partNo}\nTarget Database: ${masterItem.sysQty} pcs\nSudah di-scan: ${currentTotalQty} pcs\nKamu mencoba menambah: ${scanQty} pcs.`);
            return;
        }

        // Cegah scan QR fisik yang persis sama 2x
        const isDuplicateQR = offBsSession.some(i => i.qr === rawCode);
        if (isDuplicateQR) {
            feedback('error');
            showToast("Duplikat! Label fisik ini sudah pernah discan.");
            return;
        }

        // Simpan ke sesi dengan menyertakan QTY
        offBsSession.unshift({
            id: Date.now(),
            partNo: partNo,
            docNo: docNo,
            box: activeOffBsBox,
            qty: scanQty, // Simpan angka qty-nya
            qr: rawCode,
            time: new Date().toLocaleTimeString(),
            synced: false
        });

        localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
        renderOffBsList();
        triggerOffBsSync();
        
        feedback('success');
        showToast(`${partNo} (${scanQty} pcs) tersimpan!`);
        return; 
    }

    // --- LOGIKA NORMAL (SIMPAN, OPNAME, DATA) ---
    const item = filteredItems.find(i => i.partNo.toUpperCase() === parsedCode);
    
    if (currentTab === 'simpan') {
        if (item) {
            feedback('scan');
            if (isMultiScan) addToMultiBuffer(item);
            else { selectPartSimpan(item); setStatus(`Part: ${item.partNo}`); }
        } else {
            if (isBox) {
                if (isMultiScan) {
                    if (multiBuffer.length > 0) {
                        const hasConflicts = multiBuffer.some(i => Object.keys(i.locations).length > 0);
                        if (hasConflicts) {
                            if (confirm(`Peringatan: Beberapa part sudah punya lokasi lama.\n\n[OK] = PINDAH (Hapus lokasi lama)\n[Batal] = SPLIT (Tambah ke ${parsedCode} tanpa menghapus yang lama)`)) {
                                processMultiBatchMove(parsedCode, 'move');
                            } else {
                                processMultiBatchMove(parsedCode, 'split');
                            }
                        } else {
                            processMultiBatchMove(parsedCode, 'split');
                        }
                    }
                    else { feedback('error'); setStatus("Buffer Kosong!"); }
                } else {
                    if (tempPart) checkSimpanConflict(tempPart, parsedCode);
                    else { feedback('error'); showToast("Scan Part Dulu!"); }
                }
            } else {
                if (confirm(`Kode "${parsedCode}" Baru. Buat Part?`)) {
                    const newItem = createNewItem(parsedCode);
                    if (isMultiScan) addToMultiBuffer(newItem);
                    else selectPartSimpan(newItem);
                }
            }
        }
        return;
    }
    
    if (currentTab === 'opname') {
        if (activeBoxFilter) {
            if (isBox) { feedback('scan'); setOpnameBoxFilter(parsedCode); return; }
            if (item) {
                const currentQty = item.locations[activeBoxFilter];
                
                if (currentQty !== undefined) {
                    const currentTotalFisik = Object.values(item.locations).reduce((a,b)=>a+b,0);
                    
                    if (currentTotalFisik >= item.sysQty) {
                        feedback('error'); 
                        const forceAdd = confirm(`⚠️ PERINGATAN OVER QTY!\n\nPart: ${item.partNo}\nTarget sistem hanya ${item.sysQty}, tapi kamu mencoba men-scan barang ke-${currentTotalFisik + 1}.\n\nTetap tambahkan (+1) sebagai kelebihan stok?`);
                        if (!forceAdd) {
                            showToast("Dibatalkan (Hindari Kelebihan Qty)");
                            return; 
                        }
                    }
                    
                    item.locations[activeBoxFilter]++;
                    saveDB(item);
                    const totalFisik = Object.values(item.locations).reduce((a,b)=>a+b,0);
                    
                    if (totalFisik === item.sysQty) {
                        playChime();
                        showToast(`${item.partNo}: LENGKAP (${totalFisik}/${item.sysQty})`);
                        document.body.classList.add('flash-success');
                        setTimeout(() => document.body.classList.remove('flash-success'), 500);
                    } else if (totalFisik > item.sysQty) {
                        feedback('error');
                        showToast(`⚠️ OVER QTY: (${totalFisik}/${item.sysQty})`);
                    } else {
                        feedback('success');
                        showToast(`${item.partNo}: Qty +1`);
                    }
                    
                    registerUndo('opname_add', item.id, activeBoxFilter); 
                    lastOpnameScanId = item.id;
                    handleOpnameRender();
                    
                    setTimeout(() => {
                        const row = document.getElementById(`opname-row-${item.id}`);
                        if (row) {
                            document.querySelectorAll('.item-card').forEach(el => el.classList.remove('row-flash'));
                            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            row.classList.add('row-flash'); 
                        }
                    }, 100);
                    
                    const boxItems = filteredItems.filter(i => i.locations[activeBoxFilter] !== undefined);
                    const allComplete = boxItems.length > 0 && boxItems.every(i => {
                        const tot = Object.values(i.locations).reduce((a,b)=>a+b,0);
                        return tot >= i.sysQty;
                    });
                    
                    if (allComplete) {
                        setTimeout(() => playBoxCompleteChime(), 600);
                        showToast(`🎉 BOX ${activeBoxFilter} SELESAI SEMPURNA!`);
                    }
                    
                } else {
                    feedback('scan');
                    promptOpnameConflict(item, activeBoxFilter);
                }
            } else {
                if(confirm(`Kode "${parsedCode}" Baru. Tambah ke Box ini?`)) {
                    const newItem = createNewItem(parsedCode);
                    newItem.locations[activeBoxFilter] = 1;
                    saveDB(newItem);
                    feedback('success');
                    handleOpnameRender();
                }
            }
        } else {
            if (isBox) { feedback('scan'); setOpnameBoxFilter(parsedCode); }
            else if (item) { feedback('scan'); showOpnameInfo(item); }
            else { feedback('error'); setStatus("Scan Box untuk mulai!"); }
        }
        return;
    }
    
    if (item) {
        feedback('scan');
        jumpToItem(item.partNo);
    } else {
        feedback('error');
        setStatus("Item tidak ditemukan");
    }
}

// ==========================================
// 3. LOGIKA HISTORY & UNDO
// ==========================================
function addToHistory(code) {
    scanHistory.unshift({ code, time: new Date().toLocaleTimeString() });
    if(scanHistory.length > 3) scanHistory.pop();
    const div = document.getElementById('historyLog');
    div.innerHTML = scanHistory.map(h => 
    `<div class="hist-item"><span>${h.code}</span><small>${h.time}</small></div>`
    ).join('');
}

function registerUndo(type, itemId, box, oldState = null) {
    lastAction = { type, itemId, box, oldState, time: Date.now() };
    const btn = document.getElementById('undoBtn');
    btn.style.display = 'block';
    setTimeout(() => { 
        if (lastAction && Date.now() - lastAction.time >= 4900) btn.style.display = 'none'; 
    }, 5000);
}

function executeUndo() {
    if (!lastAction) return;
    const { type, itemId, box, oldState } = lastAction;
    const item = localItems.find(i => i.id === itemId);
    
    if (item) {
        if (type === 'opname_add') {
            if (item.locations[box] > 0) {
                item.locations[box]--;
                if (item.locations[box] === 0) delete item.locations[box]; 
                saveDB(item);
                feedback('success');
                showToast("Undo Berhasil (Qty -1)");
                if (currentTab === 'opname') handleOpnameRender();
            }
        } else if (type === 'simpan_set' || type === 'simpan_conflict') {
            if (oldState) {
                item.locations = JSON.parse(JSON.stringify(oldState));
            } else {
                delete item.locations[box];
            }
            saveDB(item);
            feedback('success');
            showToast("Undo Berhasil (Lokasi dikembalikan)");
            if (currentTab === 'simpan') {
                if (!isMultiScan) selectPartSimpan(item);
                renderSimpanList(false);
            }
        }
    }
    document.getElementById('undoBtn').style.display = 'none';
    lastAction = null;
}

// ==========================================
// 4. LOGIKA TAB SIMPAN
// ==========================================
function renderSimpanList(reset = true) {
    if(reset) renderLimit = 50;
    const container = document.getElementById('simpanList');
    const filterNoBoxEl = document.getElementById('chkFilterNoBox');
    if(reset) container.innerHTML = '';
    if(filteredItems.length === 0) return;
    const isFilterActive = filterNoBoxEl && filterNoBoxEl.checked;
    const show = filteredItems.slice(0, renderLimit);
    show.forEach(i => {
        const isActive = tempPart && tempPart.id === i.id;
        const hasLoc = Object.keys(i.locations).length > 0;
        const locTags = Object.entries(i.locations).map(([k,v])=>`<span class="loc-badge">${k}</span>`).join('');
        if (isFilterActive && hasLoc) return;
        const div = document.createElement('div');
        div.className = `item-card ${isActive ? 'selected' : ''}`;
        div.id = `simpan-row-${i.id}`;
        div.onclick = () => {
            if(!isMultiScan) selectPartSimpan(i);
            else addToMultiBuffer(i);
        };
        const styleBorder = (!hasLoc && isFilterActive) ? 'border-left: 5px solid #fb923c;' : '';
        div.style.cssText = styleBorder;
        div.innerHTML = `
        <div style="flex:1">
        <span class="part-code">${i.partNo}</span>
        <span class="part-desc">${i.desc}</span>
        <div style="margin-top:5px;">${locTags}</div>
        </div>`;
        container.appendChild(div);
    });
}

function selectPartSimpan(item) {
    if(isMultiScan) return;
    tempPart = item;
    document.getElementById('simpanStatusPanel').style.display = 'block';
    document.getElementById('activePartNo').innerText = item.partNo;
    let issueWarning = '';
    if (item.labelIssues && (item.labelIssues.DAMAGED > 0 || item.labelIssues.NO_LABEL > 0)) {
        let t = [];
        if (item.labelIssues.NO_LABEL > 0) t.push(`${item.labelIssues.NO_LABEL} Tanpa Label`);
        if (item.labelIssues.DAMAGED > 0) t.push(`${item.labelIssues.DAMAGED} Label Rusak`);
        issueWarning = `<br><span style="color:var(--danger); font-weight:bold; font-size:0.8rem;"><i class="fas fa-exclamation-triangle"></i> Catatan: ${t.join(' | ')}</span>`;
    }
    document.getElementById('activePartDesc').innerHTML = item.desc + issueWarning;
    
    const locInfo = Object.keys(item.locations).join(', ') || 'Belum ada';
    document.getElementById('activePartLoc').innerText = locInfo;
    document.querySelectorAll('.item-card').forEach(el => {
        el.classList.remove('selected');
        el.classList.remove('row-flash'); 
    });
    const row = document.getElementById(`simpan-row-${item.id}`);
    if(row) {
        row.classList.add('selected');
        row.classList.add('row-flash'); 
        row.scrollIntoView({behavior:'smooth', block:'center'});
    }
}

function clearActivePart() {
    tempPart = null;
    document.getElementById('simpanStatusPanel').style.display = 'none';
    document.querySelectorAll('.item-card').forEach(el => el.classList.remove('selected'));
}

function checkSimpanConflict(item, newBox) {
    const existingLocs = Object.keys(item.locations);
    const oldState = JSON.parse(JSON.stringify(item.locations)); 
    
    if (existingLocs.length === 0) {
        item.locations[newBox] = 0; 
        saveDB(item);
        feedback('success');
        showToast(`Lokasi diset: ${newBox}`);
        registerUndo('simpan_set', item.id, newBox, oldState);
        clearActivePart();
        return;
    }
    if (existingLocs.includes(newBox)) {
        showToast(`Part sudah ada di ${newBox}`);
        clearActivePart();
        return;
    }
    feedback('error');
    simpanConflictData = { item, newBox, oldState }; 
    document.getElementById('simpanConflictModal').style.display = 'flex';
    document.getElementById('scmPart').innerText = item.partNo;
    document.getElementById('scmOldLoc').innerText = existingLocs.join(', ');
    document.getElementById('scmNewBox').innerText = newBox;
}

function executeSimpanAction(action) {
    if (!simpanConflictData) return;
    const { item, newBox, oldState } = simpanConflictData;
    registerUndo('simpan_conflict', item.id, newBox, oldState);
    
    if (action === 'move') {
        item.locations = {}; 
        item.locations[newBox] = 0;
        showToast(`Pindah Lokasi ke ${newBox}`);
    } else if (action === 'split') {
        item.locations[newBox] = 0; 
        showToast(`Tambah Lokasi: ${newBox}`);
    }
    saveDB(item);
    feedback('success');
    closeSimpanConflictModal();
    clearActivePart();
    renderSimpanList(false); 
}

function closeSimpanConflictModal() {
    document.getElementById('simpanConflictModal').style.display = 'none';
    simpanConflictData = null;
    document.getElementById('mainInput').focus();
}

function addToMultiBuffer(item) {
    const exists = multiBuffer.some(i => i.partNo === item.partNo);
    if (exists) { showToast("Part sudah ada di list!"); return; }
    multiBuffer.push(item);
    renderMultiBuffer(); 
    const row = document.getElementById(`simpan-row-${item.id}`);
    if(row) row.classList.add('selected');
}

function renderMultiBuffer() {
    const container = document.getElementById('multiTagsContainer');
    const filterEl = document.getElementById('chkFilterNoBox');
    if (!container || !filterEl) return;
    const filterActive = filterEl.checked;
    container.innerHTML = ''; 
    let displayCount = 0;
    multiBuffer.forEach(item => {
        const locs = item.locations || {};
        const hasLoc = Object.keys(locs).length > 0;
        const locInfo = hasLoc ? Object.keys(locs).join(',') : 'Baru';
        if (filterActive && hasLoc) return;
        displayCount++;
        const tag = document.createElement('span');
        tag.className = 'multi-tag';
        const colorStyle = !hasLoc ? 'background:#fb923c; color:#fff;' : ''; 
        tag.style.cssText = colorStyle;
        tag.innerHTML = `${item.partNo} <small style="opacity:0.8">(${locInfo})</small>`;
        container.prepend(tag);
    });
    const counterEl = document.getElementById('multiCount');
    if(counterEl) counterEl.innerText = `${displayCount}/${multiBuffer.length}`;
}

function clearMultiBuffer() {
    multiBuffer = [];
    renderMultiBuffer();
    document.querySelectorAll('.item-card').forEach(el => el.classList.remove('selected'));
}

function processMultiBatchMove(box, actionType = 'move') {
    multiBuffer.forEach(item => {
        if (actionType === 'move') {
            item.locations = {}; 
        }
        if (item.locations[box] === undefined) {
            item.locations[box] = 0; 
        }
        saveDB(item);
    });
    feedback('success');
    showToast(`${multiBuffer.length} Item berhasil di-${actionType} ke ${box}`);
    clearMultiBuffer();
    renderSimpanList(false); 
}

function createNewItem(code) {
    const item = {
        id: Date.now(), partNo: code, desc: "PART BARU", 
        locType: document.getElementById('filterLoc').value,
        techName: document.getElementById('filterTech').value,
        locations: {}, sysQty: 0, raw: {}
    };
    localItems.push(item); filteredItems.push(item);
    return item;
}

// ==========================================
// 5. LOGIKA TAB OPNAME
// ==========================================
function handleOpnameRender() {
    const container = document.getElementById('opnameList');
    container.innerHTML = '';
    if(filteredItems.length === 0) return;
    let dataset = filteredItems;
    if(activeBoxFilter) dataset = dataset.filter(i => i.locations[activeBoxFilter] !== undefined); 
    dataset = dataset.filter(i => {
        const total = Object.values(i.locations).reduce((a,b)=>a+b,0);
        if(opnameFilter==='diff') return total !== i.sysQty;
        if(opnameFilter==='zero') return total === 0;
        return true;
    });
    const show = dataset.slice(0, renderLimit);
    show.forEach(i => {
        const qtyInBox = activeBoxFilter ? i.locations[activeBoxFilter] : 0;
        const totalPhysical = Object.values(i.locations).reduce((a,b)=>a+b,0);
        
        let badgeClass = '';
        let qtyDisplay = '';
        
        if (qtyInBox === 0) {
            badgeClass = 'qty-uncounted';
            qtyDisplay = `0 / ${i.sysQty}`; 
        } else {
            badgeClass = (totalPhysical === i.sysQty) ? 'qty-match' : 'qty-diff';
            if (totalPhysical > i.sysQty) badgeClass = 'qty-diff';
            
            if (Object.keys(i.locations).length > 1) {
                qtyDisplay = `${qtyInBox} <span style="font-size:0.7rem; opacity:0.8;">(Tot: ${totalPhysical}/${i.sysQty})</span>`;
            } else {
                qtyDisplay = `${qtyInBox} / ${i.sysQty}`;
            }
        }
        let locStr = activeBoxFilter 
        ? `Box ${activeBoxFilter}` 
        : Object.entries(i.locations).map(([k,v])=>`${k}(${v})`).join(', ');
        const isLastScanned = (lastOpnameScanId === i.id); 
        const div = document.createElement('div');
        div.className = `item-card ${isLastScanned ? 'selected' : ''}`; 
        div.id = `opname-row-${i.id}`;
        div.innerHTML = `
        <div style="flex:1" onclick="openEditModal(${i.id})">
        <span class="part-code">${i.partNo}</span>
        <span class="part-desc">${i.desc}</span>
        <div style="margin-top:4px; font-size:0.75rem; color:var(--opname);"><i class="fas fa-map-marker-alt"></i> ${locStr}</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
        <div class="qty-badge ${badgeClass}" onclick="openEditModal(${i.id})">${qtyDisplay}</div>
    ${activeBoxFilter ? `<div class="btn-trash" onclick="deleteLocation(${i.id}, '${activeBoxFilter}')"><i class="fas fa-trash"></i></div>` : ''}
    </div>`;
    container.appendChild(div);
    });
    document.getElementById('opnameLoading').style.display = (renderLimit < dataset.length) ? 'block' : 'none';
}

function setOpnameBoxFilter(box) {
    activeBoxFilter = box;
    document.getElementById('activeBoxName').innerText = box;
    document.getElementById('activeBoxPanel').style.display = 'block';
    document.getElementById('opnameInfoPanel').style.display = 'none'; 
    document.getElementById('opnameList').style.display = 'flex'; 
    handleOpnameRender();
}

function clearOpnameBoxFilter() {
    activeBoxFilter = null;
    document.getElementById('activeBoxPanel').style.display = 'none';
    document.getElementById('opnameInfoPanel').style.display = 'none';
    document.getElementById('opnameList').style.display = 'flex';
    handleOpnameRender();
}

function setOpnameFilter(type, btn) {
    opnameFilter = type;
    document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    handleOpnameRender();
}

function promptOpnameConflict(item, box) {
    opnameConflictData = { item, box };
    const existingLocs = Object.entries(item.locations);
    
    document.getElementById('opnameConfirmModal').style.display = 'flex';
    document.getElementById('opnameTargetBox').innerText = box;
    
    if (existingLocs.length > 0) {
        document.getElementById('opnameModalTitle').innerText = "Konflik Lokasi";
        const locInfo = existingLocs.map(([k,v]) => `• Box <b>${k}</b> : ${v} pcs`).join('<br>');
        const totalFisik = Object.values(item.locations).reduce((a,b)=>a+b,0);
        
        document.getElementById('opnameModalDesc').innerHTML = `
        <div style="background:#f8fafc; border:1px solid #cbd5e1; padding:10px; border-radius:6px; text-align:left; font-size:0.9rem; margin-bottom:10px; color:#334155;">
        <div style="margin-bottom:5px;">Sudah tercatat di lokasi lain:</div>
        ${locInfo}
        <hr style="border-top:1px dashed #cbd5e1; margin:8px 0;">
        <div>Total Fisik: <b>${totalFisik}</b> | Target Sistem: <b>${item.sysQty}</b></div>
        </div>
        `;
        document.getElementById('btnGroupConflict').style.display = 'block';
        document.getElementById('btnGroupNew').style.display = 'none';
    } else {
        document.getElementById('opnameModalTitle').innerText = "Stok Kosong";
        document.getElementById('opnameModalDesc').innerHTML = "Belum punya lokasi.";
        document.getElementById('btnGroupConflict').style.display = 'none';
        document.getElementById('btnGroupNew').style.display = 'block';
    }
}

function executeOpnameAction(action) {
    const { item, box } = opnameConflictData;
    if (action === 'move') {
        item.locations = {};
        item.locations[box] = 1;
    } else if (action === 'add') {
        item.locations[box] = 1;
    }
    saveDB(item);
    feedback('success');
    handleOpnameRender();
    closeOpnameConfirmModal();
}

function closeOpnameConfirmModal() {
    document.getElementById('opnameConfirmModal').style.display = 'none';
    opnameConflictData = null;
    document.getElementById('mainInput').focus();
}

function showOpnameInfo(item) {
    tempPart = item; 
    document.getElementById('opnameInfoPanel').style.display = 'block';
    document.getElementById('infoPartNo').innerText = item.partNo;
    document.getElementById('infoPartDesc').innerText = item.desc;
    const locs = Object.entries(item.locations).map(([k,v])=>`${k} (${v})`).join(', ');
    document.getElementById('infoLocList').innerText = locs || "Belum ada lokasi";
    document.getElementById('opnameList').style.display = 'none'; 
}

function clearOpname() {
    const warningMsg = "⚠️ PERINGATAN!\n\nApakah Anda yakin ingin MERESET SEMUA HASIL OPNAME?\n\n- Semua Qty (hasil hitung fisik) di semua box akan dikembalikan menjadi 0.\n- Nama Box/Lokasi yang sudah disetting TIDAK AKAN DIHAPUS.\n\nTindakan ini tidak bisa di-undo!";
    
    if (confirm(warningMsg)) {
        if (prompt("Ketik kata 'RESET' untuk melanjutkan:") === "RESET") {
            const tx = db.transaction('items', 'readwrite');
            const st = tx.objectStore('items');
            let resetCount = 0;
            
            localItems.forEach(item => {
                let hasChanges = false;
                for (let box in item.locations) {
                    if (item.locations[box] > 0) {
                        item.locations[box] = 0;
                        hasChanges = true;
                    }
                }
                if (hasChanges) {
                    st.put(item);
                    resetCount++;
                }
            });
            
            tx.oncomplete = () => {
                alert(`✅ Selesai!\nSebanyak ${resetCount} Part telah di-reset angka Opname-nya menjadi 0.`);
                location.reload(); 
            };
            tx.onerror = () => { alert('❌ Gagal mereset perhitungan Opname!'); };
        } else {
            alert('Batal mereset. Kata kunci salah.');
        }
    }
}

function resetCurrentBoxOpname() {
    if (!activeBoxFilter) return;
    
    if (confirm(`⚠️ ULANG PERHITUNGAN BOX: ${activeBoxFilter}?\n\nSemua part yang sudah di-scan di dalam box ini akan direset kembali menjadi 0.\n(Lokasi part tidak akan dihapus)`)) {
        let resetCount = 0;
        const tx = db.transaction('items', 'readwrite');
        const st = tx.objectStore('items');
        
        localItems.forEach(item => {
            if (item.locations[activeBoxFilter] !== undefined && item.locations[activeBoxFilter] > 0) {
                item.locations[activeBoxFilter] = 0;
                st.put(item);
                resetCount++;
            }
        });
        
        tx.oncomplete = () => {
            feedback('success');
            showToast(`✅ Hitungan Box ${activeBoxFilter} di-reset ke 0`);
            handleOpnameRender(); 
        };
        tx.onerror = () => {
            feedback('error');
            showToast('❌ Gagal mereset box!');
        };
    }
}

// ==========================================
// 6. LOGIKA TAB DATA & EDIT
// ==========================================
function renderDataList(reset = false) {
    if(reset) renderLimit = 50;
    const q = document.getElementById('cariInput').value.toLowerCase();
    const container = document.getElementById('dataList');
    if(reset || container.innerHTML === '') container.innerHTML = '';
    
    let dataset = filteredItems;
    if(filterNewOnly) dataset = dataset.filter(i => i.desc === 'PART BARU'); 
    if(q) dataset = dataset.filter(i => i.partNo.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q));
    
    const show = dataset.slice(0, renderLimit);
    if(show.length===0) { container.innerHTML='<div style="text-align:center; padding:20px; color:#999">Tidak ditemukan</div>'; return; }
    
    let html = '';
    show.forEach(i => {
        const total = Object.values(i.locations).reduce((a,b)=>a+b,0);
        const locs = Object.entries(i.locations).map(([k,v])=>`${k}(${v})`).join(', ');
        let color = total!==i.sysQty ? 'var(--danger)' : (total>0 ? 'var(--opname)' : 'var(--text)');
        let cardStyle = i.desc === 'PART BARU' ? 'border-left: 5px solid #ca8a04; background:#fffbeb;' : '';
        html += `
        <div class="item-card" id="data-row-${i.id}" onclick="openEditModal(${i.id})" style="${cardStyle}">
            <div style="flex:1;">
                <div style="display:flex; justify-content:space-between;">
                    <b style="font-size:1rem;">${i.partNo}</b> 
                    <span style="font-weight:bold; color:${color}">${total} / ${i.sysQty}</span>
                </div>
                <div style="font-size:0.8rem; color:var(--secondary);">${i.desc}</div>
                <div style="font-size:0.8rem; color:var(--data); margin-top:4px;">
                    <i class="fas fa-map-marker-alt"></i> ${locs || '-'}
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
    document.getElementById('dataLoading').style.display = (renderLimit < dataset.length) ? 'block' : 'none';
}

function toggleNewPartFilter(btn) {
    filterNewOnly = !filterNewOnly;
    if(filterNewOnly) {
        btn.classList.add('btn-warning');
        btn.classList.remove('btn-outline');
        btn.innerHTML = '<i class="fas fa-check"></i> Cuma Part Baru';
    } else {
        btn.classList.remove('btn-warning');
        btn.classList.add('btn-outline');
        btn.innerHTML = '<i class="fas fa-filter"></i> Cuma Part Baru';
    }
    renderDataList(true);
}

function jumpToItem(partNo) {
    const index = filteredItems.findIndex(i => i.partNo.toUpperCase() === partNo.toUpperCase());
    if (index === -1) {
        feedback('error');
        showToast("Part tidak ditemukan di filter ini");
        return;
    }
    const item = filteredItems[index];
    document.getElementById('cariInput').value = ''; 
    if (index >= renderLimit) renderLimit = index + 20;
    renderDataList(false); 
    setTimeout(() => {
        const row = document.getElementById(`data-row-${item.id}`);
        if (row) {
            document.querySelectorAll('.item-card').forEach(el => el.classList.remove('row-flash'));
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.classList.add('row-flash'); 
            playTone(800, 'sine', 0.1);
        }
    }, 100);
}

function openEditModal(id) {
    editId = id;
    const item = localItems.find(i=>i.id===id);
    if(!item) return;
    document.getElementById('editModal').style.display='flex';
    document.getElementById('editPartTitle').innerText = item.partNo;
    const list = document.getElementById('editLocsList');
    list.innerHTML='';
    Object.keys(item.locations).forEach(box => {
        const r = document.createElement('div');
        r.style.cssText="display:flex; justify-content:space-between; margin-bottom:8px; align-items:center;";
        r.innerHTML=`
        <b>${box}</b> 
        <div style="display:flex; gap:5px;">
            <input type="number" class="edit-qty-input" data-box="${box}" value="${item.locations[box]}" style="width:60px; padding:5px;">
            <button class="btn-trash" style="width:30px; height:30px;" onclick="deleteLocation(${id}, '${box}')"><i class="fas fa-trash"></i></button>
        </div>`;
        list.appendChild(r);
    });
    const delBtnContainer = document.getElementById('editDeleteBtnContainer');
    if (item.desc === 'PART BARU') {
        delBtnContainer.innerHTML = `<button class="btn btn-danger" style="margin-top:15px;" onclick="deletePartBaru(${item.id})"><i class="fas fa-trash-alt"></i> Hapus Part Ini Permanen</button>`;
    } else {
        delBtnContainer.innerHTML = '';
    }
}

function deleteLocation(id, box) {
    if(confirm(`Hapus part ini dari box ${box}?`)) {
        const item = localItems.find(i=>i.id===id);
        if (item) {
            delete item.locations[box];
            saveDB(item);
            feedback('success');
            if(document.getElementById('editModal').style.display === 'flex') openEditModal(id);
            if(currentTab === 'opname') handleOpnameRender();
            if(currentTab === 'data') renderDataList(false);
        }
    }
}

function addManualLoc() {
    const box = document.getElementById('editNewBox').value.toUpperCase();
    const qty = parseInt(document.getElementById('editNewQty').value);
    
    if (box && !isNaN(qty)) {
        const item = localItems.find(i => i.id === editId);
        item.locations[box] = qty || 0; 
        saveDB(item); 
        openEditModal(editId);
    } else {
        showToast("Box atau Qty tidak valid!");
    }
}

function saveManualEdit() {
    const item = localItems.find(i=>i.id===editId);
    document.querySelectorAll('.edit-qty-input').forEach(inp => {
        const v = parseInt(inp.value);
        if(!isNaN(v)) item.locations[inp.dataset.box]=v; 
    });
    saveDB(item); 
    document.getElementById('editModal').style.display='none'; 
    handleOpnameRender(); 
    renderDataList(false);
    document.getElementById('mainInput').focus();
}

function deletePartBaru(id) {
    if(confirm('Hapus Part Baru ini dari database secara permanen?')) {
        const tx = db.transaction('items', 'readwrite');
        tx.objectStore('items').delete(id);
        tx.oncomplete = () => {
            localItems = localItems.filter(i => i.id !== id);
            filteredItems = filteredItems.filter(i => i.id !== id);
            document.getElementById('editModal').style.display='none';
            renderDataList(true);
            showToast('Part dihapus.');
        };
    }
}

function addLabelIssue(type) {
    if (!tempPart) return;
    if (!tempPart.labelIssues) tempPart.labelIssues = { DAMAGED: 0, NO_LABEL: 0 };
    
    let typeName = type === 'DAMAGED' ? 'Rusak' : 'Tanpa Label';
    let input = prompt(`Berapa buah part ${tempPart.partNo} yang labelnya ${typeName}? \n(Ketik angka saja)`, "1");
    let qty = parseInt(input);
    
    if (!isNaN(qty) && qty > 0) {
        tempPart.labelIssues[type] += qty;
        saveDB(tempPart);
        feedback('success');
        showToast(`${qty} part ditandai ${typeName}`);
        selectPartSimpan(tempPart); 
    } else if (input !== null) {
        showToast("Angka tidak valid!");
    }
}

function openLabelReport() {
    const container = document.getElementById('labelReportList');
    let html = '';
    let count = 0;
    
    localItems.forEach(i => {
        if (i.labelIssues && (i.labelIssues.DAMAGED > 0 || i.labelIssues.NO_LABEL > 0)) {
            count++;
            const locs = Object.keys(i.locations).join(', ') || 'Belum masuk Box';
            html += `
            <div style="padding:10px; border:1px solid var(--border); border-radius:6px; background:#fef2f2;">
            <b>${i.partNo}</b> <span style="font-size:0.8rem; color:var(--secondary)">${i.desc}</span>
            <div style="display:flex; gap:15px; margin-top:8px; font-size:0.85rem; font-weight:bold;">
        ${i.labelIssues.NO_LABEL > 0 ? `<span style="color:var(--danger);"><i class="fas fa-tag"></i> Hilang: ${i.labelIssues.NO_LABEL} pcs</span>` : ''}
        ${i.labelIssues.DAMAGED > 0 ? `<span style="color:#d97706;"><i class="fas fa-tags"></i> Rusak: ${i.labelIssues.DAMAGED} pcs</span>` : ''}
        </div>
        <div style="font-size:0.75rem; color:var(--secondary); margin-top:6px;">Lokasi Fisik: ${locs}</div>
        </div>`;
        }
    });
    
    if (count === 0) {
        html = '<div style="text-align:center; padding:30px; color:var(--opname);"><i class="fas fa-check-circle" style="font-size:2rem; margin-bottom:10px; display:block;"></i>Semua Label Aman!</div>';
    }
    
    container.innerHTML = html;
    document.getElementById('labelReportModal').style.display = 'flex';
}

function openRakModal() {
    const raks = new Set();
    localItems.forEach(i => Object.keys(i.locations).forEach(box => raks.add(box.charAt(0).toUpperCase())));
    
    const sel = document.getElementById('rakSelect');
    sel.innerHTML = '<option value="">-- Pilih Rak yang Ingin Dicek --</option>';
    [...raks].sort().forEach(r => sel.innerHTML += `<option value="${r}">Rak ${r}</option>`);
    
    document.getElementById('rakSummaryList').innerHTML = '<div style="text-align:center; color:#999; padding:20px;">Pilih rak di atas</div>';
    document.getElementById('rakModal').style.display = 'flex';
}

function renderRakSummary() {
    const rak = document.getElementById('rakSelect').value;
    const container = document.getElementById('rakSummaryList');
    if (!rak) { container.innerHTML = ''; return; }
    
    let html = '';
    let missingCount = 0;
    
    localItems.forEach(i => {
        const boxesInRak = Object.keys(i.locations).filter(b => b.startsWith(rak));
        if (boxesInRak.length > 0) {
            const totalFisik = Object.values(i.locations).reduce((a,b)=>a+b,0);
            if (totalFisik < i.sysQty) {
                missingCount++;
                html += `
                <div style="padding:10px; border-left:4px solid var(--danger); background:#fef2f2; border-radius:4px;">
                    <div style="display:flex; justify-content:space-between;">
                        <b style="color:var(--danger)">${i.partNo}</b>
                        <span style="font-size:0.8rem; font-weight:bold; color:var(--danger)">${totalFisik} / ${i.sysQty}</span>
                    </div>
                    <div style="font-size:0.8rem; color:#666; margin-top:4px;">
                        Harusnya di: ${boxesInRak.map(b => `${b}(${i.locations[b]})`).join(', ')}
                    </div>
                </div>`;
            }
        }
    });
    
    if (missingCount === 0) {
        html = '<div style="text-align:center; padding:30px; color:#16a34a; font-weight:bold;"><i class="fas fa-check-circle" style="font-size:3rem; margin-bottom:10px; display:block;"></i>Semua Part di Rak ini AMAN & KOMPLIT!</div>';
    }
    container.innerHTML = html;
}

// ==========================================
// 7. LOGIKA TAB OFF BS
// ==========================================
// UPDATE: Tampilan List OFF BS (Menampilkan status Cloud)
function renderOffBsList() {
    const container = document.getElementById('offBsList');
    const totalPcs = offBsSession.reduce((sum, item) => sum + item.qty, 0);
    const unsyncedCount = offBsSession.filter(i => !i.synced).length;
    
    // Beri peringatan di jumlah scan jika ada yang belum sync
    const syncWarning = unsyncedCount > 0 ? `<span style="color:var(--danger); font-size:0.8rem; margin-left:10px;">(${unsyncedCount} blm sync)</span>` : '';
    document.getElementById('offBsCount').innerHTML = `${offBsSession.length} Scan (${totalPcs} pcs) ${syncWarning}`;
    
    container.innerHTML = '';
    
    offBsSession.forEach((item, index) => {
        // Ikon Awan: Hijau jika sudah masuk G-Sheet, Oranye berkedip jika belum
        const cloudIcon = item.synced 
            ? `<i class="fas fa-cloud-check" style="color:#16a34a; font-size:1.1rem;"></i>` 
            : `<i class="fas fa-cloud-upload-alt" style="color:#f59e0b; font-size:1.1rem;" title="Menunggu Sync..."></i>`;

        const div = document.createElement('div');
        div.className = 'item-card';
        div.style.borderLeft = '5px solid var(--offbs)';
        div.innerHTML = `
            <div style="flex:1;">
                <div style="font-weight:bold; font-size:1rem;">
                    ${item.partNo} 
                    <span style="color:var(--danger); font-size:0.85rem; margin-left:5px;">(${item.qty} pcs)</span>
                </div>
                <div style="font-family:monospace; font-size:0.75rem; color:var(--secondary); margin-top:2px;">${item.docNo}</div>
                <div style="font-size:0.75rem; color:var(--offbs); margin-top:4px;"><i class="fas fa-box"></i> ${item.box}</div>
            </div>
            <div style="text-align:right; display:flex; flex-direction:column; align-items:flex-end; justify-content:space-between;">
                <div style="font-size:0.65rem; color:#999;">${item.time}</div>
                <div style="margin-top:5px; margin-bottom:5px;">${cloudIcon}</div>
                <button class="btn-trash" style="width:30px; height:30px;" onclick="deleteOffBsItem(${item.id})"><i class="fas fa-trash"></i></button>
            </div>
        `;
        container.appendChild(div);
    });
}

function clearOffBsBox() {
    activeOffBsBox = null;
    document.getElementById('activeOffBsBoxName').innerText = "Belum Diset";
    document.getElementById('mainInput').focus();
}

function deleteOffBsItem(id) {
    if(confirm("Hapus scan ini?")) {
        offBsSession = offBsSession.filter(i => i.id !== id);
        localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
        renderOffBsList();
    }
}

function clearOffBsSession() {
    if(offBsSession.length === 0) return;
    if(confirm("PERINGATAN!\nKamu akan mereset seluruh sesi packing OFF BS ini. Pastikan data sudah di-Export.\n\nLanjutkan?")) {
        offBsSession = [];
        localStorage.removeItem('wms_off_bs');
        renderOffBsList();
    }
}

// ==========================================
// FUNGSI BARU: Auto-Sync khusus OFF BS ke Cloud
// ==========================================
async function triggerOffBsSync() {
    // Jangan sync jika internet mati atau proses sync lain sedang berjalan
    if (!navigator.onLine || isSyncing) return;

    // Filter hanya data yang belum ter-sync
    const unsyncedData = offBsSession.filter(i => !i.synced);
    if (unsyncedData.length === 0) return; // Tidak ada yang perlu di-sync

    isSyncing = true;
    updateSyncUI("🔄 Syncing OFF BS...");

    try {
        const payload = {
            action: "sync_off_bs",
            data: unsyncedData
        };

        const response = await fetch(API_URL, {
            method: "POST",
            redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.status === "success") {
            // Jika berhasil, ubah bendera synced menjadi true
            unsyncedData.forEach(u => u.synced = true);
            // Simpan perubahan bendera ke memori lokal
            localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
            
            updateSyncUI("🟢 OFF BS Tersimpan");
            if(currentTab === 'offbs') renderOffBsList(); // Segarkan ikon awan di layar
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
// 8. LOGIKA NAVIGASI TAB
// ==========================================
// ==========================================
// 8. LOGIKA NAVIGASI TAB
// ==========================================
function switchTab(id) {
    currentTab = id;
    document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
    document.getElementById('tab-'+id).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(e=>e.classList.remove('active'));
    event.currentTarget.classList.add('active');
    document.getElementById('scrollTopBtn').style.display = 'none';
    
    const multiToggle = document.getElementById('multiScanToggle');
    const filterToggle = document.getElementById('filterNoBoxToggle');
    const chkFilter = document.getElementById('chkFilterNoBox'); 
    const isMulti = document.getElementById('chkMultiScan') ? document.getElementById('chkMultiScan').checked : false;
    
    // Ambil elemen UI global
    const globalFilter = document.querySelector('.global-filter');
    const scannerBar = document.querySelector('.scanner-bar'); // <--- 1. Targetkan Scanner Bar
    
    // Atur visibilitas fitur berdasarkan Tab
    if (id === 'simpan') {
        multiToggle.style.display = 'flex';
        filterToggle.style.display = isMulti ? 'flex' : 'none'; 
        if(globalFilter) globalFilter.style.display = 'flex'; 
    } else if (id === 'offbs') {
        multiToggle.style.display = 'none';
        filterToggle.style.display = 'none';
        if(globalFilter) globalFilter.style.display = 'none'; 
    } else {
        multiToggle.style.display = 'none';
        filterToggle.style.display = 'none';
        if(globalFilter) globalFilter.style.display = 'flex'; 
        if(chkFilter && chkFilter.checked) chkFilter.checked = false;
    }
    
    // <--- 2. LOGIKA BARU: Sembunyikan Scanner Bar KHUSUS di tab 'data'
    if (scannerBar) {
        scannerBar.style.display = (id === 'data') ? 'none' : 'block';
    }
    
    const root = document.documentElement;
    if(id === 'simpan') {
        root.style.setProperty('--active-color', isMulti ? 'var(--purple)' : 'var(--primary)');
        document.querySelector('header').style.background = isMulti ? 'var(--purple)' : 'var(--primary)';
    }
    if(id === 'opname') {
        root.style.setProperty('--active-color', 'var(--opname)');
        document.querySelector('header').style.background = 'var(--opname)';
    }
    if(id === 'data') {
        root.style.setProperty('--active-color', 'var(--data)');
        document.querySelector('header').style.background = 'var(--data)';
    }
    if(id === 'offbs') {
        root.style.setProperty('--active-color', 'var(--offbs)');
        document.querySelector('header').style.background = 'var(--offbs)';
        renderOffBsList(); 
    }
    
    if(id === 'opname') handleOpnameRender();
    if(id === 'simpan') renderSimpanList(true); 
    if(id === 'data') renderDataList(true);
    
    // <--- 3. LOGIKA BARU: Auto-focus ke input yang tepat
    if (id === 'data') {
        document.getElementById('cariInput').focus();
    } else {
        document.getElementById('mainInput').focus();
    }
}

function clearData() { 
    if(confirm('Hapus Semua?')) { 
        const tx = db.transaction('items','readwrite'); 
        tx.objectStore('items').clear(); 
        tx.oncomplete = () => location.reload(); 
    }
}
