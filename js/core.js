// js/core.js

// ===== QR CODE PARSER =====
function parseQRCode(rawCode) {
    /**
     * Try parsing QR code against configured formats
     * Returns: { partNo, qty, docNo, parser: parserName } or null
     */
    for (const [parserKey, config] of Object.entries(QR_PARSERS)) {
        const match = rawCode.match(config.pattern);
        if (match) {
            return { 
                ...config.extract(match), 
                parser: config.name 
            };
        }
    }
    return null; // No match found
}

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

function processScan(code) {
    let rawCode = code.trim().toUpperCase();
    let parsedCode = rawCode.includes('|') ? rawCode.split('|')[0] : rawCode;

    addToHistory(parsedCode);

    const boxPattern = /^[A-Z][0-9]{0,2}-[0-9]{2,3}$/;
    const isBox = boxPattern.test(rawCode);

    // ==========================================
    // LOGIKA TAB PACKING / PENGIRIMAN (BARU)
    // ==========================================
if (currentTab === 'packing') {
        if (!activeColly) {
            feedback('error');
            showToast("Pilih atau Buat Colly terlebih dahulu!");
            return;
        }

        // Use configurable QR parser
        const parsed = parseQRCode(rawCode);
        if (!parsed) {
            feedback('error');
            showToast("Format QR tidak dikenali. Periksa format atau konfigurasi.");
            return;
        }

        let { partNo, qty: scanQty, docNo } = parsed;

        const isDup = packingSession.some(i => i.qr === rawCode);
        if (isDup) { feedback('error'); showToast("Sudah discan di Colly ini!"); return; }

        // ===== CUT & PASTE dari OFF BS =====
        // Cari part yang sama di OFF BS session
        const offBsItem = offBsSession.find(i => i.partNo === partNo && i.qr === rawCode);
        if (offBsItem) {
            // Part ini ada di OFF BS, hapus dari OFF BS (cut)
            offBsSession = offBsSession.filter(i => i.id !== offBsItem.id);
            localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
            if(typeof renderOffBsList === 'function') renderOffBsList();
        }

        // Tambah ke PACKING (paste)
        packingSession.unshift({
            id: Date.now(), 
            partNo: partNo, 
            docNo: docNo, 
            qty: scanQty, 
            qr: rawCode, 
            colly: activeColly, 
            time: new Date().toLocaleTimeString(), 
            updated_at: Date.now(),  // Timestamp for two-way sync
            synced: false
        });

        localStorage.setItem('wms_packing', JSON.stringify(packingSession));
        renderPackingList();
        triggerPackingSync();
        
        feedback('success');
        if (offBsItem) {
            showToast(`✅ ${partNo} dipindah dari OFF BS → Colly!`);
        } else {
            showToast(`${partNo} Masuk Colly!`);
        }
        return;
    }

    // ==========================================
    // LOGIKA TAB OFF BS
    // ==========================================
    if (currentTab === 'offbs') {
        if (rawCode.startsWith('RTF')) {
            activeOffBsBox = rawCode;
            document.getElementById('activeOffBsBoxName').innerText = rawCode;
            feedback('scan'); showToast(`Box OFF BS Aktif: ${rawCode}`);
            return;
        }

        if (!activeOffBsBox) { feedback('error'); showToast("TOLAKAN: Scan Box Tujuan (RTF) dulu!"); return; }
        if (isBox && !rawCode.startsWith('RTF')) { feedback('error'); alert(`TOLAKAN!\n\nIni box reguler (${rawCode}).`); return; }

        // Use configurable QR parser
        const parsed = parseQRCode(rawCode);
        if (!parsed) {
            feedback('error');
            showToast("TOLAKAN: Format QR tidak dikenali!");
            return;
        }

        let { partNo, qty: scanQty, docNo } = parsed;

        const masterItem = localItems.find(i => i.partNo === partNo && (i.locType || '').toUpperCase().includes('OFF BS'));
        if (!masterItem) { feedback('error'); alert(`TOLAKAN:\nPart ${partNo} tidak terdaftar OFF BS!`); return; }

        const currentTotalQty = offBsSession.filter(i => i.partNo === partNo).reduce((sum, item) => sum + item.qty, 0);
        if ((currentTotalQty + scanQty) > masterItem.sysQty) {
            feedback('error'); alert(`OVER QTY!\nPart: ${partNo}\nTarget: ${masterItem.sysQty}\nDiscan: ${currentTotalQty}\nTambah: ${scanQty}`); return;
        }

        const isDuplicateQR = offBsSession.some(i => i.qr === rawCode);
        if (isDuplicateQR) { feedback('error'); showToast("Duplikat! Label fisik ini sudah pernah discan."); return; }

        offBsSession.unshift({
            id: Date.now(), 
            partNo: partNo, 
            docNo: docNo, 
            box: activeOffBsBox, 
            qty: scanQty, 
            qr: rawCode, 
            time: new Date().toLocaleTimeString(),
            updated_at: Date.now(),  // Timestamp for two-way sync
            synced: false
        });

        localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
        if(typeof renderOffBsList === 'function') renderOffBsList();
        if(typeof triggerOffBsSync === 'function') triggerOffBsSync();
        
        feedback('success'); showToast(`${partNo} (${scanQty} pcs) tersimpan!`);
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
                            if (confirm(`Peringatan: Beberapa part sudah punya lokasi lama.\n\n[OK] = PINDAH\n[Batal] = SPLIT`)) { processMultiBatchMove(parsedCode, 'move'); } 
                            else { processMultiBatchMove(parsedCode, 'split'); }
                        } else { processMultiBatchMove(parsedCode, 'split'); }
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
                        if (!confirm(`⚠️ OVER QTY!\nPart: ${item.partNo}\nTarget: ${item.sysQty}\nTetap tambahkan (+1)?`)) { showToast("Dibatalkan"); return; }
                    }
                    item.locations[activeBoxFilter]++; saveDB(item);
                    const totalFisik = Object.values(item.locations).reduce((a,b)=>a+b,0);
                    if (totalFisik === item.sysQty) {
                        playChime(); showToast(`${item.partNo}: LENGKAP`);
                        document.body.classList.add('flash-success'); setTimeout(() => document.body.classList.remove('flash-success'), 500);
                    } else if (totalFisik > item.sysQty) { feedback('error'); showToast(`⚠️ OVER QTY: (${totalFisik}/${item.sysQty})`);
                    } else { feedback('success'); showToast(`${item.partNo}: Qty +1`); }
                    
                    registerUndo('opname_add', item.id, activeBoxFilter); 
                    lastOpnameScanId = item.id; handleOpnameRender();
                    
                    setTimeout(() => {
                        const row = document.getElementById(`opname-row-${item.id}`);
                        if (row) {
                            document.querySelectorAll('.item-card').forEach(el => el.classList.remove('row-flash'));
                            row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.add('row-flash'); 
                        }
                    }, 100);
                    
                    const boxItems = filteredItems.filter(i => i.locations[activeBoxFilter] !== undefined);
                    const allComplete = boxItems.length > 0 && boxItems.every(i => Object.values(i.locations).reduce((a,b)=>a+b,0) >= i.sysQty);
                    if (allComplete) { setTimeout(() => playBoxCompleteChime(), 600); showToast(`🎉 BOX ${activeBoxFilter} SELESAI SEMPURNA!`); }
                } else { feedback('scan'); promptOpnameConflict(item, activeBoxFilter); }
            } else {
                if(confirm(`Kode "${parsedCode}" Baru. Tambah ke Box ini?`)) {
                    const newItem = createNewItem(parsedCode); newItem.locations[activeBoxFilter] = 1; saveDB(newItem); feedback('success'); handleOpnameRender();
                }
            }
        } else {
            if (isBox) { feedback('scan'); setOpnameBoxFilter(parsedCode); }
            else if (item) { feedback('scan'); showOpnameInfo(item); }
            else { feedback('error'); setStatus("Scan Box untuk mulai!"); }
        }
        return;
    }
    
    if (item) { feedback('scan'); jumpToItem(item.partNo); } 
    else { feedback('error'); setStatus("Item tidak ditemukan"); }
}

function addToHistory(code) {
    scanHistory.unshift({ code, time: new Date().toLocaleTimeString() });
    if(scanHistory.length > 3) scanHistory.pop();
    const div = document.getElementById('historyLog');
    div.innerHTML = scanHistory.map(h => `<div class="hist-item"><span>${h.code}</span><small>${h.time}</small></div>`).join('');
}

function registerUndo(type, itemId, box, oldState = null) {
    lastAction = { type, itemId, box, oldState, time: Date.now() };
    const btn = document.getElementById('undoBtn'); btn.style.display = 'block';
    setTimeout(() => { if (lastAction && Date.now() - lastAction.time >= 4900) btn.style.display = 'none'; }, 5000);
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
                saveDB(item); feedback('success'); showToast("Undo Berhasil (Qty -1)");
                if (currentTab === 'opname') handleOpnameRender();
            }
        } else if (type === 'simpan_set' || type === 'simpan_conflict') {
            if (oldState) item.locations = JSON.parse(JSON.stringify(oldState)); else delete item.locations[box];
            saveDB(item); feedback('success'); showToast("Undo Berhasil");
            if (currentTab === 'simpan') { if (!isMultiScan) selectPartSimpan(item); renderSimpanList(false); }
        }
    }
    document.getElementById('undoBtn').style.display = 'none'; lastAction = null;
}

function renderSimpanList(reset = true) {
    if(reset) renderLimit = 50;
    const container = document.getElementById('simpanList'); const filterNoBoxEl = document.getElementById('chkFilterNoBox');
    if(reset) container.innerHTML = ''; if(filteredItems.length === 0) return;
    const isFilterActive = filterNoBoxEl && filterNoBoxEl.checked;
    const show = filteredItems.slice(0, renderLimit);
    show.forEach(i => {
        const isActive = tempPart && tempPart.id === i.id;
        const hasLoc = Object.keys(i.locations).length > 0;
        const locTags = Object.entries(i.locations).map(([k,v])=>`<span class="loc-badge">${k}</span>`).join('');
        if (isFilterActive && hasLoc) return;
        const div = document.createElement('div');
        div.className = `item-card ${isActive ? 'selected' : ''}`; div.id = `simpan-row-${i.id}`;
        div.onclick = () => { if(!isMultiScan) selectPartSimpan(i); else addToMultiBuffer(i); };
        div.style.cssText = (!hasLoc && isFilterActive) ? 'border-left: 5px solid #fb923c;' : '';
        div.innerHTML = `<div style="flex:1"><span class="part-code">${i.partNo}</span><span class="part-desc">${i.desc}</span><div style="margin-top:5px;">${locTags}</div></div>`;
        container.appendChild(div);
    });
}

function selectPartSimpan(item) {
    if(isMultiScan) return; tempPart = item;
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
    document.getElementById('activePartLoc').innerText = Object.keys(item.locations).join(', ') || 'Belum ada';
    document.querySelectorAll('.item-card').forEach(el => { el.classList.remove('selected'); el.classList.remove('row-flash'); });
    const row = document.getElementById(`simpan-row-${item.id}`);
    if(row) { row.classList.add('selected'); row.classList.add('row-flash'); row.scrollIntoView({behavior:'smooth', block:'center'}); }
    
    // Render Smart Suggestion
    renderSmartSuggestion(item);
}

function clearActivePart() {
    tempPart = null; document.getElementById('simpanStatusPanel').style.display = 'none';
    document.querySelectorAll('.item-card').forEach(el => el.classList.remove('selected'));
    // Reset Smart Suggestion Panel
    const panelEl = document.getElementById('smartSuggestionPanel');
    const listEl = document.getElementById('smartSuggestionList');
    const chevron = document.getElementById('smartSuggestionChevron');
    if (panelEl) panelEl.style.display = 'none';
    if (listEl) listEl.innerHTML = '';
    if (chevron) chevron.style.transform = 'rotate(0deg)';
}

function checkSimpanConflict(item, newBox) {
    const existingLocs = Object.keys(item.locations); const oldState = JSON.parse(JSON.stringify(item.locations)); 
    if (existingLocs.length === 0) { item.locations[newBox] = 0; saveDB(item); feedback('success'); showToast(`Lokasi diset: ${newBox}`); registerUndo('simpan_set', item.id, newBox, oldState); clearActivePart(); return; }
    if (existingLocs.includes(newBox)) { showToast(`Part sudah ada di ${newBox}`); clearActivePart(); return; }
    feedback('error'); simpanConflictData = { item, newBox, oldState }; 
    document.getElementById('simpanConflictModal').style.display = 'flex';
    document.getElementById('scmPart').innerText = item.partNo; document.getElementById('scmOldLoc').innerText = existingLocs.join(', '); document.getElementById('scmNewBox').innerText = newBox;
}

function executeSimpanAction(action) {
    if (!simpanConflictData) return; const { item, newBox, oldState } = simpanConflictData; registerUndo('simpan_conflict', item.id, newBox, oldState);
    if (action === 'move') { item.locations = {}; item.locations[newBox] = 0; showToast(`Pindah Lokasi ke ${newBox}`); } 
    else if (action === 'split') { item.locations[newBox] = 0; showToast(`Tambah Lokasi: ${newBox}`); }
    saveDB(item); feedback('success'); closeSimpanConflictModal(); clearActivePart(); renderSimpanList(false); 
}

function closeSimpanConflictModal() { document.getElementById('simpanConflictModal').style.display = 'none'; simpanConflictData = null; document.getElementById('mainInput').focus(); }

function addToMultiBuffer(item) {
    const exists = multiBuffer.some(i => i.partNo === item.partNo); if (exists) { showToast("Part sudah ada di list!"); return; }
    multiBuffer.push(item); renderMultiBuffer(); 
    const row = document.getElementById(`simpan-row-${item.id}`); if(row) row.classList.add('selected');
}

function renderMultiBuffer() {
    const container = document.getElementById('multiTagsContainer'); const filterEl = document.getElementById('chkFilterNoBox');
    if (!container || !filterEl) return; const filterActive = filterEl.checked; container.innerHTML = ''; let displayCount = 0;
    multiBuffer.forEach(item => {
        const locs = item.locations || {}; const hasLoc = Object.keys(locs).length > 0; const locInfo = hasLoc ? Object.keys(locs).join(',') : 'Baru';
        if (filterActive && hasLoc) return; displayCount++;
        const tag = document.createElement('span'); tag.className = 'multi-tag'; tag.style.cssText = !hasLoc ? 'background:#fb923c; color:#fff;' : ''; 
        tag.innerHTML = `${item.partNo} <small style="opacity:0.8">(${locInfo})</small>`; container.prepend(tag);
    });
    const counterEl = document.getElementById('multiCount'); if(counterEl) counterEl.innerText = `${displayCount}/${multiBuffer.length}`;
}

function clearMultiBuffer() { multiBuffer = []; renderMultiBuffer(); document.querySelectorAll('.item-card').forEach(el => el.classList.remove('selected')); }

function processMultiBatchMove(box, actionType = 'move') {
    multiBuffer.forEach(item => { if (actionType === 'move') item.locations = {}; if (item.locations[box] === undefined) item.locations[box] = 0; saveDB(item); });
    feedback('success'); showToast(`${multiBuffer.length} Item berhasil di-${actionType} ke ${box}`); clearMultiBuffer(); renderSimpanList(false); 
}

function createNewItem(code) {
    const item = { id: Date.now(), partNo: code, desc: "PART BARU", locType: document.getElementById('filterLoc').value, techName: document.getElementById('filterTech').value, locations: {}, sysQty: 0, raw: {} };
    localItems.push(item); filteredItems.push(item); return item;
}

function handleOpnameRender() {
    const container = document.getElementById('opnameList'); container.innerHTML = ''; if(filteredItems.length === 0) return;
    let dataset = filteredItems; if(activeBoxFilter) dataset = dataset.filter(i => i.locations[activeBoxFilter] !== undefined); 
    dataset = dataset.filter(i => {
        const total = Object.values(i.locations).reduce((a,b)=>a+b,0);
        if(opnameFilter==='diff') return total !== i.sysQty;
        if(opnameFilter==='zero') return total === 0; return true;
    });
    const show = dataset.slice(0, renderLimit);
    show.forEach(i => {
        const qtyInBox = activeBoxFilter ? i.locations[activeBoxFilter] : 0; const totalPhysical = Object.values(i.locations).reduce((a,b)=>a+b,0);
        let badgeClass = ''; let qtyDisplay = '';
        if (qtyInBox === 0) { badgeClass = 'qty-uncounted'; qtyDisplay = `0 / ${i.sysQty}`; } 
        else {
            badgeClass = (totalPhysical === i.sysQty) ? 'qty-match' : 'qty-diff'; if (totalPhysical > i.sysQty) badgeClass = 'qty-diff';
            if (Object.keys(i.locations).length > 1) qtyDisplay = `${qtyInBox} <span style="font-size:0.7rem; opacity:0.8;">(Tot: ${totalPhysical}/${i.sysQty})</span>`;
            else qtyDisplay = `${qtyInBox} / ${i.sysQty}`;
        }
        let locStr = activeBoxFilter ? `Box ${activeBoxFilter}` : Object.entries(i.locations).map(([k,v])=>`${k}(${v})`).join(', ');
        const div = document.createElement('div'); div.className = `item-card ${(lastOpnameScanId === i.id) ? 'selected' : ''}`; div.id = `opname-row-${i.id}`;
        div.innerHTML = `
        <div style="flex:1" onclick="openEditModal(${i.id})"><span class="part-code">${i.partNo}</span><span class="part-desc">${i.desc}</span><div style="margin-top:4px; font-size:0.75rem; color:var(--opname);"><i class="fas fa-map-marker-alt"></i> ${locStr}</div></div>
        <div style="display:flex; gap:8px; align-items:center;"><div class="qty-badge ${badgeClass}" onclick="openEditModal(${i.id})">${qtyDisplay}</div>
        ${activeBoxFilter ? `<div class="btn-trash" onclick="deleteLocation(${i.id}, '${activeBoxFilter}')"><i class="fas fa-trash"></i></div>` : ''}</div>`;
        container.appendChild(div);
    });
    document.getElementById('opnameLoading').style.display = (renderLimit < dataset.length) ? 'block' : 'none';
}

function setOpnameBoxFilter(box) { activeBoxFilter = box; document.getElementById('activeBoxName').innerText = box; document.getElementById('activeBoxPanel').style.display = 'block'; document.getElementById('opnameInfoPanel').style.display = 'none'; document.getElementById('opnameList').style.display = 'flex'; handleOpnameRender(); }
function clearOpnameBoxFilter() { activeBoxFilter = null; document.getElementById('activeBoxPanel').style.display = 'none'; document.getElementById('opnameInfoPanel').style.display = 'none'; document.getElementById('opnameList').style.display = 'flex'; handleOpnameRender(); }
function setOpnameFilter(type, btn) { opnameFilter = type; document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); handleOpnameRender(); }

function promptOpnameConflict(item, box) {
    opnameConflictData = { item, box }; const existingLocs = Object.entries(item.locations);
    document.getElementById('opnameConfirmModal').style.display = 'flex'; document.getElementById('opnameTargetBox').innerText = box;
    if (existingLocs.length > 0) {
        document.getElementById('opnameModalTitle').innerText = "Konflik Lokasi"; const totalFisik = Object.values(item.locations).reduce((a,b)=>a+b,0);
        document.getElementById('opnameModalDesc').innerHTML = `<div style="background:#f8fafc; border:1px solid #cbd5e1; padding:10px; border-radius:6px; text-align:left; font-size:0.9rem; margin-bottom:10px; color:#334155;"><div style="margin-bottom:5px;">Sudah tercatat di lokasi lain:</div>${existingLocs.map(([k,v]) => `• Box <b>${k}</b> : ${v} pcs`).join('<br>')}<hr style="border-top:1px dashed #cbd5e1; margin:8px 0;"><div>Total Fisik: <b>${totalFisik}</b> | Target Sistem: <b>${item.sysQty}</b></div></div>`;
        document.getElementById('btnGroupConflict').style.display = 'block'; document.getElementById('btnGroupNew').style.display = 'none';
    } else {
        document.getElementById('opnameModalTitle').innerText = "Stok Kosong"; document.getElementById('opnameModalDesc').innerHTML = "Belum punya lokasi.";
        document.getElementById('btnGroupConflict').style.display = 'none'; document.getElementById('btnGroupNew').style.display = 'block';
    }
}

function executeOpnameAction(action) { const { item, box } = opnameConflictData; if (action === 'move') { item.locations = {}; item.locations[box] = 1; } else if (action === 'add') { item.locations[box] = 1; } saveDB(item); feedback('success'); handleOpnameRender(); closeOpnameConfirmModal(); }
function closeOpnameConfirmModal() { document.getElementById('opnameConfirmModal').style.display = 'none'; opnameConflictData = null; document.getElementById('mainInput').focus(); }
function showOpnameInfo(item) { tempPart = item; document.getElementById('opnameInfoPanel').style.display = 'block'; document.getElementById('infoPartNo').innerText = item.partNo; document.getElementById('infoPartDesc').innerText = item.desc; document.getElementById('infoLocList').innerText = Object.entries(item.locations).map(([k,v])=>`${k} (${v})`).join(', ') || "Belum ada lokasi"; document.getElementById('opnameList').style.display = 'none'; }

function clearOpname() {
    if (confirm("⚠️ PERINGATAN!\n\nReset SEMUA HASIL OPNAME (Qty jadi 0)?")) {
        if (prompt("Ketik kata 'RESET' untuk melanjutkan:") === "RESET") {
            const tx = db.transaction('items', 'readwrite'); const st = tx.objectStore('items'); let resetCount = 0;
            localItems.forEach(item => {
                let hasChanges = false; for (let box in item.locations) { if (item.locations[box] > 0) { item.locations[box] = 0; hasChanges = true; } }
                if (hasChanges) { st.put(item); resetCount++; }
            });
            tx.oncomplete = () => { alert(`✅ Selesai!\n${resetCount} Part di-reset.`); location.reload(); }; tx.onerror = () => { alert('❌ Gagal mereset!'); };
        } else { alert('Batal mereset.'); }
    }
}

function resetCurrentBoxOpname() {
    if (!activeBoxFilter) return;
    if (confirm(`⚠️ ULANG PERHITUNGAN BOX: ${activeBoxFilter}?`)) {
        const tx = db.transaction('items', 'readwrite'); const st = tx.objectStore('items');
        localItems.forEach(item => { if (item.locations[activeBoxFilter] > 0) { item.locations[activeBoxFilter] = 0; st.put(item); } });
        tx.oncomplete = () => { feedback('success'); showToast(`✅ Box ${activeBoxFilter} di-reset ke 0`); handleOpnameRender(); };
    }
}

function renderDataList(reset = false) {
    if(reset) renderLimit = 50; const q = document.getElementById('cariInput').value.toLowerCase(); const container = document.getElementById('dataList');
    if(reset || container.innerHTML === '') container.innerHTML = '';
    let dataset = filteredItems; if(filterNewOnly) dataset = dataset.filter(i => i.desc === 'PART BARU'); 
    if(q) dataset = dataset.filter(i => i.partNo.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q));
    const show = dataset.slice(0, renderLimit); if(show.length===0) { container.innerHTML='<div style="text-align:center; padding:20px; color:#999">Tidak ditemukan</div>'; return; }
    let html = '';
    show.forEach(i => {
        const total = Object.values(i.locations).reduce((a,b)=>a+b,0); const locs = Object.entries(i.locations).map(([k,v])=>`${k}(${v})`).join(', ');
        let color = total!==i.sysQty ? 'var(--danger)' : (total>0 ? 'var(--opname)' : 'var(--text)');
        let cardStyle = i.desc === 'PART BARU' ? 'border-left: 5px solid #ca8a04; background:#fffbeb;' : '';
        html += `<div class="item-card" id="data-row-${i.id}" onclick="openEditModal(${i.id})" style="${cardStyle}"><div style="flex:1;"><div style="display:flex; justify-content:space-between;"><b style="font-size:1rem;">${i.partNo}</b> <span style="font-weight:bold; color:${color}">${total} / ${i.sysQty}</span></div><div style="font-size:0.8rem; color:var(--secondary);">${i.desc}</div><div style="font-size:0.8rem; color:var(--data); margin-top:4px;"><i class="fas fa-map-marker-alt"></i> ${locs || '-'}</div></div></div>`;
    });
    container.innerHTML = html; document.getElementById('dataLoading').style.display = (renderLimit < dataset.length) ? 'block' : 'none';
}

function toggleNewPartFilter(btn) { filterNewOnly = !filterNewOnly; if(filterNewOnly) { btn.classList.add('btn-warning'); btn.classList.remove('btn-outline'); btn.innerHTML = '<i class="fas fa-check"></i> Cuma Part Baru'; } else { btn.classList.remove('btn-warning'); btn.classList.add('btn-outline'); btn.innerHTML = '<i class="fas fa-filter"></i> Cuma Part Baru'; } renderDataList(true); }
function jumpToItem(partNo) {
    const index = filteredItems.findIndex(i => i.partNo.toUpperCase() === partNo.toUpperCase()); if (index === -1) { feedback('error'); showToast("Part tidak ditemukan"); return; }
    document.getElementById('cariInput').value = ''; if (index >= renderLimit) renderLimit = index + 20; renderDataList(false); 
    setTimeout(() => { const row = document.getElementById(`data-row-${filteredItems[index].id}`); if (row) { document.querySelectorAll('.item-card').forEach(el => el.classList.remove('row-flash')); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.add('row-flash'); playTone(800, 'sine', 0.1); } }, 100);
}

function openEditModal(id) {
    editId = id; const item = localItems.find(i=>i.id===id); if(!item) return; document.getElementById('editModal').style.display='flex'; document.getElementById('editPartTitle').innerText = item.partNo;
    const list = document.getElementById('editLocsList'); list.innerHTML='';
    Object.keys(item.locations).forEach(box => { const r = document.createElement('div'); r.style.cssText="display:flex; justify-content:space-between; margin-bottom:8px; align-items:center;"; r.innerHTML=`<b>${box}</b> <div style="display:flex; gap:5px;"><input type="number" class="edit-qty-input" data-box="${box}" value="${item.locations[box]}" style="width:60px; padding:5px;"><button class="btn-trash" style="width:30px; height:30px;" onclick="deleteLocation(${id}, '${box}')"><i class="fas fa-trash"></i></button></div>`; list.appendChild(r); });
    document.getElementById('editDeleteBtnContainer').innerHTML = item.desc === 'PART BARU' ? `<button class="btn btn-danger" style="margin-top:15px;" onclick="deletePartBaru(${item.id})"><i class="fas fa-trash-alt"></i> Hapus Part Ini Permanen</button>` : '';
}

function deleteLocation(id, box) { if(confirm(`Hapus part ini dari box ${box}?`)) { const item = localItems.find(i=>i.id===id); if (item) { delete item.locations[box]; saveDB(item); feedback('success'); if(document.getElementById('editModal').style.display === 'flex') openEditModal(id); if(currentTab === 'opname') handleOpnameRender(); if(currentTab === 'data') renderDataList(false); } } }
function addManualLoc() { const box = document.getElementById('editNewBox').value.toUpperCase(); const qty = parseInt(document.getElementById('editNewQty').value); if (box && !isNaN(qty)) { const item = localItems.find(i => i.id === editId); item.locations[box] = qty || 0; saveDB(item); openEditModal(editId); } else { showToast("Box/Qty tak valid!"); } }
function saveManualEdit() { const item = localItems.find(i=>i.id===editId); document.querySelectorAll('.edit-qty-input').forEach(inp => { const v = parseInt(inp.value); if(!isNaN(v)) item.locations[inp.dataset.box]=v; }); saveDB(item); document.getElementById('editModal').style.display='none'; handleOpnameRender(); renderDataList(false); document.getElementById('mainInput').focus(); }
function deletePartBaru(id) { if(confirm('Hapus Part Baru ini permanen?')) { const tx = db.transaction('items', 'readwrite'); tx.objectStore('items').delete(id); tx.oncomplete = () => { localItems = localItems.filter(i => i.id !== id); filteredItems = filteredItems.filter(i => i.id !== id); document.getElementById('editModal').style.display='none'; renderDataList(true); showToast('Dihapus.'); }; } }
function addLabelIssue(type) { if (!tempPart) return; if (!tempPart.labelIssues) tempPart.labelIssues = { DAMAGED: 0, NO_LABEL: 0 }; let typeName = type === 'DAMAGED' ? 'Rusak' : 'Tanpa Label'; let input = prompt(`Berapa buah part ${tempPart.partNo} yang labelnya ${typeName}? \n(Ketik angka saja)`, "1"); let qty = parseInt(input); if (!isNaN(qty) && qty > 0) { tempPart.labelIssues[type] += qty; saveDB(tempPart); feedback('success'); showToast(`${qty} part ditandai`); selectPartSimpan(tempPart); } }
function openLabelReport() { const container = document.getElementById('labelReportList'); let html = ''; let count = 0; localItems.forEach(i => { if (i.labelIssues && (i.labelIssues.DAMAGED > 0 || i.labelIssues.NO_LABEL > 0)) { count++; html += `<div style="padding:10px; border:1px solid var(--border); border-radius:6px; background:#fef2f2;"><b>${i.partNo}</b> <span style="font-size:0.8rem; color:var(--secondary)">${i.desc}</span><div style="display:flex; gap:15px; margin-top:8px; font-size:0.85rem; font-weight:bold;">${i.labelIssues.NO_LABEL > 0 ? `<span style="color:var(--danger);"><i class="fas fa-tag"></i> Hilang: ${i.labelIssues.NO_LABEL} pcs</span>` : ''}${i.labelIssues.DAMAGED > 0 ? `<span style="color:#d97706;"><i class="fas fa-tags"></i> Rusak: ${i.labelIssues.DAMAGED} pcs</span>` : ''}</div><div style="font-size:0.75rem; color:var(--secondary); margin-top:6px;">Lokasi: ${Object.keys(i.locations).join(', ') || 'Belum Box'}</div></div>`; } }); if (count === 0) html = '<div style="text-align:center; padding:30px; color:var(--opname);"><i class="fas fa-check-circle" style="font-size:2rem; margin-bottom:10px; display:block;"></i>Semua Label Aman!</div>'; container.innerHTML = html; document.getElementById('labelReportModal').style.display = 'flex'; }
function openRakModal() { const raks = new Set(); localItems.forEach(i => Object.keys(i.locations).forEach(box => raks.add(box.charAt(0).toUpperCase()))); const sel = document.getElementById('rakSelect'); sel.innerHTML = '<option value="">-- Pilih Rak --</option>'; [...raks].sort().forEach(r => sel.innerHTML += `<option value="${r}">Rak ${r}</option>`); document.getElementById('rakSummaryList').innerHTML = '<div style="text-align:center; color:#999; padding:20px;">Pilih rak di atas</div>'; document.getElementById('rakModal').style.display = 'flex'; }
function renderRakSummary() { const rak = document.getElementById('rakSelect').value; const container = document.getElementById('rakSummaryList'); if (!rak) { container.innerHTML = ''; return; } let html = ''; let missingCount = 0; localItems.forEach(i => { const boxesInRak = Object.keys(i.locations).filter(b => b.startsWith(rak)); if (boxesInRak.length > 0) { const totalFisik = Object.values(i.locations).reduce((a,b)=>a+b,0); if (totalFisik < i.sysQty) { missingCount++; html += `<div style="padding:10px; border-left:4px solid var(--danger); background:#fef2f2; border-radius:4px;"><div style="display:flex; justify-content:space-between;"><b style="color:var(--danger)">${i.partNo}</b><span style="font-size:0.8rem; font-weight:bold; color:var(--danger)">${totalFisik} / ${i.sysQty}</span></div><div style="font-size:0.8rem; color:#666; margin-top:4px;">Harusnya di: ${boxesInRak.map(b => `${b}(${i.locations[b]})`).join(', ')}</div></div>`; } } }); if (missingCount === 0) html = '<div style="text-align:center; padding:30px; color:#16a34a; font-weight:bold;"><i class="fas fa-check-circle" style="font-size:3rem; margin-bottom:10px; display:block;"></i>Aman & Komplit!</div>'; container.innerHTML = html; }

// ============================================
// SMART SUGGESTION FUNCTIONS
// ============================================

function getBasePart(partNo) {
    if (!partNo) return '';
    const parts = partNo.split('-');
    if (parts.length >= 2) {
        return parts[0] + '-' + parts[1];
    }
    return partNo;
}

function toggleSmartSuggestion() {
    const listEl = document.getElementById('smartSuggestionList');
    const chevron = document.getElementById('smartSuggestionChevron');
    const isOpen = listEl.style.display !== 'none';
    listEl.style.display = isOpen ? 'none' : 'block';
    chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
}

function renderSmartSuggestion(item) {
    if (!item) return;
    
    const panelEl = document.getElementById('smartSuggestionPanel');
    const headerEl = document.getElementById('smartSuggestionHeader');
    const textEl = document.getElementById('smartSuggestionText');
    const listEl = document.getElementById('smartSuggestionList');
    const chevron = document.getElementById('smartSuggestionChevron');
    
    // Get base part for this item
    const basePart = getBasePart(item.partNo);
    
    // Find sibling parts with same base but different ID and with locations
    const siblings = localItems.filter(sibling => {
        return sibling.id !== item.id && 
               getBasePart(sibling.partNo) === basePart && 
               Object.keys(sibling.locations).length > 0;
    });
    
    if (siblings.length === 0) {
        // Hide panel if no siblings found
        panelEl.style.display = 'none';
        listEl.innerHTML = '';
        chevron.style.transform = 'rotate(0deg)';
        return;
    }
    
    // Show panel with siblings
    panelEl.style.display = 'block';
    
    // Update header text
    textEl.innerText = `💡 Ada ${siblings.length} Part Seri Serupa`;
    
    // Render siblings list
    let html = '';
    siblings.forEach(sibling => {
        const boxes = Object.keys(sibling.locations).map(box => `${box}`).join(', ');
        const boxDisplay = boxes ? boxes : 'Belum ada box';
        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #fce7ba; font-size:0.85rem;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <div style="font-weight:bold; color:#92400e;">${sibling.partNo}</div>
                    <div style="font-size:0.75rem; color:#b45309;">➔ ${boxDisplay}</div>
                </div>
                <button onclick="selectPartSimpan(localItems.find(i=>i.id===${sibling.id}))" style="padding:4px 8px; background:#f59e0b; color:white; border:none; border-radius:4px; cursor:pointer; font-size:0.75rem; font-weight:bold;">Lihat</button>
            </div>
        `;
    });
    
    listEl.innerHTML = html;
    
    // Close accordion by default (chevron down, list hidden)
    listEl.style.display = 'none';
    chevron.style.transform = 'rotate(0deg)';
}

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
    const globalFilter = document.querySelector('.global-filter');
    const scannerBar = document.querySelector('.scanner-bar');
    
    if (id === 'simpan') { multiToggle.style.display = 'flex'; filterToggle.style.display = isMulti ? 'flex' : 'none'; if(globalFilter) globalFilter.style.display = 'flex'; 
    } else if (id === 'offbs' || id === 'packing') { multiToggle.style.display = 'none'; filterToggle.style.display = 'none'; if(globalFilter) globalFilter.style.display = 'none'; 
    } else { multiToggle.style.display = 'none'; filterToggle.style.display = 'none'; if(globalFilter) globalFilter.style.display = 'flex'; if(chkFilter && chkFilter.checked) chkFilter.checked = false; }
    
    if (scannerBar) { scannerBar.style.display = (id === 'data') ? 'none' : 'block'; }
    
    const root = document.documentElement;
    if(id === 'simpan') { root.style.setProperty('--active-color', isMulti ? 'var(--purple)' : 'var(--primary)'); document.querySelector('header').style.background = isMulti ? 'var(--purple)' : 'var(--primary)'; }
    if(id === 'opname') { root.style.setProperty('--active-color', 'var(--opname)'); document.querySelector('header').style.background = 'var(--opname)'; handleOpnameRender(); }
    if(id === 'data') { root.style.setProperty('--active-color', 'var(--data)'); document.querySelector('header').style.background = 'var(--data)'; renderDataList(true); }
    if(id === 'offbs') { root.style.setProperty('--active-color', 'var(--offbs)'); document.querySelector('header').style.background = 'var(--offbs)'; if(typeof renderOffBsList==='function') renderOffBsList(); }
    if(id === 'packing') { root.style.setProperty('--active-color', '#10b981'); document.querySelector('header').style.background = '#10b981'; if(typeof renderCollyUI==='function') renderCollyUI(); if(typeof renderPackingList==='function') renderPackingList(); }
    
    if (id === 'data') document.getElementById('cariInput').focus(); else document.getElementById('mainInput').focus();
}

function clearData() { if(confirm('Hapus Semua?')) { const tx = db.transaction('items','readwrite'); tx.objectStore('items').clear(); tx.oncomplete = () => location.reload(); } }