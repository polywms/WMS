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
    // Clear both buffers when filter changes
    if (Array.isArray(multiBuffer) && multiBuffer.length > 0) clearMultiBuffer();
    if (Array.isArray(simpanBuffer) && simpanBuffer.length > 0) clearSimpanBuffer();
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
    // Auto-Buffer is default mode now - toggle disabled
    showToast("🔄 Auto-Buffer Mode Active");
}

function toggleHistoryAccordion() {
    const accordion = document.getElementById('historyAccordion');
    const btn = document.getElementById('historyToggleBtn');
    const isOpen = accordion.style.display !== 'none';
    accordion.style.display = isOpen ? 'none' : 'block';
    
    if (!isOpen) {
        btn.style.background = 'var(--primary)';
        btn.style.color = 'white';
        btn.style.borderColor = 'var(--primary)';
    } else {
        btn.style.background = 'white';
        btn.style.color = 'var(--secondary)';
        btn.style.borderColor = '#cbd5e1';
    }
}

function toggleOptionsAccordion() {
    const accordion = document.getElementById('optionsAccordion');
    const btn = document.getElementById('optionsToggleBtn');
    const isOpen = accordion.style.display !== 'none';
    accordion.style.display = isOpen ? 'none' : 'block';
    
    if (!isOpen) {
        btn.style.background = 'var(--primary)';
        btn.style.color = 'white';
        btn.style.borderColor = 'var(--primary)';
    } else {
        btn.style.background = 'white';
        btn.style.color = 'var(--secondary)';
        btn.style.borderColor = '#cbd5e1';
    }
}

function toggleOpnameMode() {
    isOpnameMode = document.getElementById('chkOpnameMode').checked;
    if (isOpnameMode) {
        showToast("📊 Mode Opname Aktif - Input Qty setelah scan part");
        feedback('success');
    } else {
        showToast("Mode Opname Non-aktif");
        feedback('info');
    }
    document.getElementById('mainInput').focus();
}

function addHistoryLog(partNo, boxNo) {
    scanHistoryLog.unshift({ 
        partNo: partNo, 
        box: boxNo, 
        time: new Date().toISOString(),
        timestamp: Date.now()
    });
    
    // Limit history to 20 items
    if (scanHistoryLog.length > 20) scanHistoryLog.pop();
    
    // Update count badge
    const countEl = document.getElementById('historyCount');
    if (countEl) countEl.textContent = scanHistoryLog.length;
    
    // Render history items
    renderHistoryLog();
}

function renderHistoryLog() {
    const container = document.getElementById('historyLog');
    if (!container) return;
    
    if (scanHistoryLog.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:8px; color:var(--text-secondary); font-size:0.8rem;">Belum ada riwayat scan</div>';
        return;
    }
    
    container.innerHTML = scanHistoryLog.map(item => `
        <div style="padding:6px 8px; border-bottom:1px solid var(--border); font-size:0.85rem; line-height:1.3;">
            <span style="color:var(--primary);">✓</span> <strong>${item.partNo}</strong> >> <strong>${item.box}</strong> <span style="color:var(--text-secondary); font-size:0.75rem;">${item.time}</span>
        </div>
    `).join('');
}

function processScan(code) {
    let rawCode = code.trim().toUpperCase();
    let parsedCode = rawCode.includes('|') ? rawCode.split('|')[0].trim() : rawCode;

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
            time: new Date().toISOString(), 
            updated_at: Date.now(),  // Timestamp for two-way sync
            synced: false
        });

        localStorage.setItem('wms_packing', JSON.stringify(packingSession));
        renderPackingList();
        triggerPackingSync();
        addHistoryLog(partNo, activeColly);
        
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
            time: new Date().toISOString(),
            updated_at: Date.now(),  // Timestamp for two-way sync
            synced: false
        });

        localStorage.setItem('wms_off_bs', JSON.stringify(offBsSession));
        if(typeof renderOffBsList === 'function') renderOffBsList();
        if(typeof triggerOffBsSync === 'function') triggerOffBsSync();
        addHistoryLog(partNo, activeOffBsBox);
        
        feedback('success'); showToast(`${partNo} (${scanQty} pcs) tersimpan!`);
        return; 
    }

    // --- LOGIKA NORMAL (SIMPAN, OPNAME, DATA) ---
    const item = filteredItems.find(i => i.partNo.toUpperCase() === parsedCode);
    
    if (currentTab === 'simpan') {
        if (isBox) {
            // Set temporary target box for conflict detection
            targetBufferBox = parsedCode;
            
            // Check if simpanBuffer has items that conflict with this box
            const conflictedItems = simpanBuffer.filter(b => {
                const lastBox = b.item.lastBox || '-';
                // Conflict if: lastBox is not empty, not '-', and doesn't match target
                return lastBox !== '-' && lastBox !== parsedCode;
            });
            
            // If conflicts exist, show modal; otherwise save all directly
            if (conflictedItems.length > 0) {
                showConflictModal(conflictedItems);
                return;
            }
            
            // Safe to save: no conflicts - SAVE ALL ITEMS IN BUFFER to target box
            if (simpanBuffer.length > 0) {
                const boxCode = parsedCode;
                let savedCount = 0;
                let totalQtySaved = 0;
                
                // Save EACH item in buffer to the target box
                simpanBuffer.forEach(bufferItem => {
                    const item = bufferItem.item;
                    const scannedQty = bufferItem.qty;
                    
                    // PROTEKSI: Cek apakah qty akan over dari sysQty
                    const totalPhysical = Object.values(item.locations).reduce((a, b) => a + b, 0);
                    if ((totalPhysical + scannedQty) > item.sysQty) {
                        feedback('error');
                        alert(`⚠️ OVER QTY!\n\nPart: ${item.partNo}\nTarget Sistem: ${item.sysQty}\nUdah Ada: ${totalPhysical}\nMau Tambah: ${scannedQty}\nTotal: ${totalPhysical + scannedQty}\n\nGunakan SPLIT jika perlu pindahkan ke box lain!`);
                        return;  // Skip this item on qty violation
                    }
                    
                    // Add or update location
                    if (!item.locations[boxCode]) {
                        item.locations[boxCode] = 0;
                    }
                    item.locations[boxCode] += scannedQty;
                    item.lastBox = boxCode;  // Update lastBox tracking
                    
                    // Save to database
                    saveDB(item);
                    savedCount++;
                    totalQtySaved += scannedQty;
                    
                    addHistoryLog(`${item.partNo} → ${boxCode}`, `+${scannedQty}`);
                });
                
                // Show summary feedback
                if (savedCount > 0) {
                    feedback('success');
                    if (typeof playChime === 'function') playChime();
                    
                    if (savedCount === 1) {
                        showToast(`✅ ${simpanBuffer[0].item.partNo} (${totalQtySaved} pcs) masuk ke ${boxCode}!`);
                    } else {
                        showToast(`✅ ${savedCount} part (${totalQtySaved} pcs total) masuk ke ${boxCode}!`);
                    }
                    
                    // Clear entire buffer and reset
                    simpanBuffer = [];
                    tempPart = null;
                    targetBufferBox = null;
                    clearSimpanBuffer();  // Clear UI
                    renderSimpanList(true);
                }
                
                return;
            }
            
            // No items in buffer but trying to scan box
            feedback('error');
            showToast("⚠️ Scan Part terlebih dahulu sebelum scan Box!");
            return;
            
        } else if (item) {
            // ==========================================
            // JIKA SCAN PART -> AKUMULASI QTY (x1, x2)
            // ==========================================
            feedback('scan');
            addToSimpanBuffer(item);
            return;
            
        } else {
            // ==========================================
            // PART BARU
            // ==========================================
            if (confirm(`Kode "${parsedCode}" Baru. Buat Part?`)) {
                const newItem = createNewItem(parsedCode);
                addToSimpanBuffer(newItem);
            }
            return;
        }
    }
    
    if (currentTab === 'opname') {
        // ===== OPNAME MODE: opnameBuffer-based workflow =====
        if (opnameBufferBox !== null) {
            // Buffer is active (box already scanned) - accumulate parts
            if (isBox) {
                // Scan another box = finalize current buffer
                if (opnameBuffer.length > 0) {
                    processOpnameBuffer(parsedCode);
                    return;
                } else {
                    // Change target box without processing
                    opnameBufferBox = parsedCode;
                    setOpnameBoxFilter(parsedCode);  // ← TAMBAHAN: Trigger filter update
                    feedback('scan');
                    showToast(`📦 Box ditubah ke: ${parsedCode}`);
                    return;
                }
            } else if (item) {
                // Scan part = add to buffer
                addToOpnameBuffer(item);
                return;
            } else {
                if(confirm(`Kode "${parsedCode}" Baru. Tambah ke Buffer?`)) {
                    const newItem = createNewItem(parsedCode);
                    addToOpnameBuffer(newItem);
                }
                return;
            }
        } else {
            // Buffer not initialized - first box scan or info display
            if (isBox) {
                feedback('scan');
                opnameBufferBox = parsedCode;
                setOpnameBoxFilter(parsedCode);  // ← TAMBAHAN: Trigger filter + display
                showOpnameBufferPanel();
                showToast(`📦 Box ${parsedCode} set. Scan part untuk akumulasi qty...`);
                return;
            } else if (item) {
                feedback('scan');
                showOpnameInfo(item);
                return;
            } else {
                feedback('error');
                setStatus("Scan Box atau Part!");
                return;
            }
        }
    }
    
    if (item) { feedback('scan'); jumpToItem(item.partNo); } 
    else { feedback('error'); setStatus("Item tidak ditemukan"); }
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
            if (currentTab === 'simpan') { renderSimpanList(false); }
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
        const totalQty = Object.values(i.locations).reduce((a,b)=>a+b,0);
        
        // Tulis jumlah tersimpan di sebelah part number
        const qtyDisplay = totalQty > 0 ? `<span style="background:#dcfce7; color:#16a34a; padding:2px 8px; border-radius:8px; font-size:0.8rem; font-weight:bold; margin-left:8px; border:1px solid #86efac;">x ${totalQty}</span>` : '';
        
        if (isFilterActive && hasLoc) return;
        const div = document.createElement('div');
        div.className = `item-card ${isActive ? 'selected' : ''}`; div.id = `simpan-row-${i.id}`;
        div.onclick = () => { addToSimpanBuffer(i); };
        div.style.cssText = (!hasLoc && isFilterActive) ? 'border-left: 5px solid #fb923c;' : '';
        
        // locTags ditaruh 1 baris menggunakan flex wrap agar aman jika layar sempit
        div.innerHTML = `
        <div style="flex:1">
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:4px;">
                <span class="part-code" style="font-size:1.05rem; font-weight:bold;">${i.partNo}</span>
                ${qtyDisplay}
                ${locTags ? `<div style="display:flex; gap:4px; margin-left:auto; flex-wrap:wrap;">${locTags}</div>` : ''}
            </div>
            <span class="part-desc" style="font-size:0.85rem; color:#64748b;">${i.desc}</span>
        </div>`;
        container.appendChild(div);
    });
}

function selectPartSimpan(item) {
    // Legacy function for single-scan mode; auto-buffer always active now
    // This function is not called anymore but kept for backward compatibility
    
    tempPart = item;
    // Validate simpanBuffer and clear it
    if (!Array.isArray(simpanBuffer)) simpanBuffer = [];
    simpanBuffer = []; // Kosongkan buffer karena cuma dilihat, belum di-scan
    
    document.getElementById('simpanStatusPanel').style.display = 'block';
    
    // Hitung total tersimpan untuk tampilan "Hanya Dilihat"
    const qtyTersimpan = Object.values(item.locations).reduce((a,b)=>a+b, 0);
    let color = qtyTersimpan >= item.sysQty ? '#16a34a' : '#ea580c';
    let progressBadge = `<span style="font-size:0.85rem; color:${color}; background:#f8fafc; padding:2px 8px; border-radius:6px; border:1px solid #cbd5e1; margin-left:8px; font-weight:bold;">Terisi: ${qtyTersimpan}/${item.sysQty}</span>`;
    
    // Taruh menyamping di sebelah Nama Part
    document.getElementById('activePartNo').innerHTML = item.partNo + progressBadge;
    
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
    
    if(typeof renderSmartSuggestion === 'function') renderSmartSuggestion(item);
    renderSimpanBuffer();
}

function clearActivePart() {
    tempPart = null; 
    // Clear simpanBuffer when clearing active part
    clearSimpanBuffer();
    document.getElementById('simpanStatusPanel').style.display = 'none';
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
    if (existingLocs.length === 0) { item.locations[newBox] = 0; saveDB(item); addHistoryLog(item.partNo, newBox); feedback('success'); showToast(`Lokasi diset: ${newBox}`); registerUndo('simpan_set', item.id, newBox, oldState); clearActivePart(); return; }
    if (existingLocs.includes(newBox)) { showToast(`Part sudah ada di ${newBox}`); clearActivePart(); return; }
    feedback('error'); simpanConflictData = { item, newBox, oldState }; 
    document.getElementById('simpanConflictModal').style.display = 'flex';
    document.getElementById('scmPart').innerText = item.partNo; document.getElementById('scmOldLoc').innerText = existingLocs.join(', '); document.getElementById('scmNewBox').innerText = newBox;
}

function executeSimpanAction(action) {
    if (!simpanConflictData) return; 
    const { item, newBox, qty } = simpanConflictData; 
    
    if (action === 'move') { 
        // LOGIKA PINDAH: Kurangi dari rak lama sejumlah qty yang di-scan
        let sisaPindah = qty;
        for (let loc in item.locations) {
            if (sisaPindah <= 0) break;
            if (item.locations[loc] > 0) {
                if (item.locations[loc] >= sisaPindah) {
                    item.locations[loc] -= sisaPindah;
                    sisaPindah = 0;
                } else {
                    sisaPindah -= item.locations[loc];
                    item.locations[loc] = 0;
                }
            }
        }
        // Bersihkan data rak lama jika stoknya habis jadi 0
        for (let loc in item.locations) {
            if (item.locations[loc] <= 0) delete item.locations[loc];
        }
        
        // Pindahkan ke rak baru
        if (!item.locations[newBox]) item.locations[newBox] = 0;
        item.locations[newBox] += qty;
        
        showToast(`✅ Pindah ${qty} pcs ke ${newBox}`); 
    } 
    else if (action === 'split') { 
        // LOGIKA TAMBAH (INBOUND): Biarkan rak lama utuh, tambah barang baru di rak baru
        if (!item.locations[newBox]) item.locations[newBox] = 0;
        item.locations[newBox] += qty;
        showToast(`✅ Stok Baru (+${qty}) ditambah ke ${newBox}`); 
    }
    
    // Simpan ke database dan bersihkan layar
    saveDB(item); 
    addHistoryLog(`${item.partNo} → ${newBox}`, action === 'move' ? `Pindah ${qty}` : `Tambah ${qty}`); 
    feedback('scan_saved'); 
    closeSimpanConflictModal(); 
    clearSimpanBuffer(); 
    renderSimpanList(true); 
}

function closeSimpanConflictModal() { document.getElementById('simpanConflictModal').style.display = 'none'; simpanConflictData = null; document.getElementById('mainInput').focus(); }

function addToMultiBuffer(item) {
    // Validate multiBuffer exists
    if (!Array.isArray(multiBuffer)) {
        console.warn('multiBuffer not initialized, initializing now');
        multiBuffer = [];
    }
    // Cek apakah item sudah ada di buffer
    const existing = multiBuffer.find(b => b.item.id === item.id);
    if (existing) {
        existing.qty++;
        showToast(`${item.partNo} ➔ x ${existing.qty}`);
    } else {
        multiBuffer.push({ item: item, qty: 1 });
        showToast(`${item.partNo} ➔ x 1`);
    }
    renderMultiBuffer(); 
    const row = document.getElementById(`simpan-row-${item.id}`); 
    if(row) row.classList.add('selected');
}

function renderMultiBuffer() {
    const container = document.getElementById('multiTagsContainer'); 
    const filterEl = document.getElementById('chkFilterNoBox');
    if (!container || !filterEl) return; 
    
    // Validate multiBuffer exists and is array
    if (!Array.isArray(multiBuffer) || multiBuffer.length === 0) {
        container.innerHTML = '';
        const counterEl = document.getElementById('multiCount'); 
        if(counterEl) counterEl.innerText = '0/0';
        return;
    }
    
    const filterActive = filterEl.checked; 
    container.innerHTML = ''; 
    let displayCount = 0;
    
    multiBuffer.forEach((bufferItem, idx) => {
        const item = bufferItem.item;
        const qty = bufferItem.qty;
        const locs = item.locations || {}; 
        const hasLoc = Object.keys(locs).length > 0; 
        const locInfo = hasLoc ? Object.keys(locs).join(',') : 'Baru';
        if (filterActive && hasLoc) return; 
        displayCount++;
        
        // Format: PART-NO x2 / 10, lokasi1,lokasi2
        const tag = document.createElement('div'); 
        tag.className = 'multi-tag'; 
        tag.style.cssText = `
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            background: ${!hasLoc ? 'var(--purple)' : '#f0f0f0'};
            color: ${!hasLoc ? 'white' : '#333'};
            border-radius: 6px;
            font-size: 0.85rem;
            white-space: nowrap;
            min-width: 200px;
        `;
        tag.innerHTML = `
            <span style="font-weight: bold; flex: 1; overflow: hidden; text-overflow: ellipsis;">${item.partNo}</span>
            <span style="background: ${!hasLoc ? 'rgba(255,255,255,0.3)' : '#e0e0e0'}; padding: 2px 6px; border-radius: 4px; font-weight: bold;">x${qty}/${item.sysQty}</span>
            <small style="opacity: 0.8;">${locInfo}</small>
        `;
        container.appendChild(tag);
    });
    
    const counterEl = document.getElementById('multiCount'); 
    if(counterEl) counterEl.innerText = `${displayCount}/${multiBuffer.length}`;
}

function clearMultiBuffer() { 
    if (!Array.isArray(multiBuffer)) multiBuffer = [];
    multiBuffer = []; 
    renderMultiBuffer(); 
    document.querySelectorAll('.item-card').forEach(el => el.classList.remove('selected')); 
}

function processMultiBatchMove(box, actionType = 'move') {
    if (!Array.isArray(multiBuffer) || multiBuffer.length === 0) {
        feedback('error');
        showToast("Buffer kosong!");
        return;
    }
    
    let successCount = 0;
    multiBuffer.forEach(bufferItem => {
        const item = bufferItem.item;
        const qty = bufferItem.qty;
        
        if (actionType === 'move') {
            item.locations = {};  // Clear old locations
        }
        if (item.locations[box] === undefined) {
            item.locations[box] = 0;
        }
        item.locations[box] += qty;  // Add accumulated qty
        saveDB(item);
        successCount++;
    });
    
    feedback('success'); 
    showToast(`✅ ${successCount} Item (${multiBuffer.reduce((a,b)=>a+b.qty, 0)} pcs) berhasil di-${actionType} ke ${box}`); 
    clearMultiBuffer(); 
    renderSimpanList(false); 
}

function createNewItem(code) {
    const item = { id: Date.now(), partNo: code, desc: "PART BARU", locType: document.getElementById('filterLoc').value, techName: document.getElementById('filterTech').value, locations: {}, sysQty: 0, raw: {}, lastOpnameDate: '', lastBox: '-' };
    localItems.push(item); filteredItems.push(item); return item;
}

function handleOpnameRender() {
    const container = document.getElementById('opnameList'); container.innerHTML = ''; if(filteredItems.length === 0) return;
    let dataset = filteredItems;
    
    // FIXED: Apply filter based on activeBoxFilter correctly
    if(activeBoxFilter) {
        // Step 1: Filter untuk hanya items yang ada di box ini
        dataset = dataset.filter(i => i.locations[activeBoxFilter] !== undefined);
        
        // Step 2: Apply opnameFilter AFTER box filtering
        dataset = dataset.filter(i => {
            const qtyInBox = i.locations[activeBoxFilter] || 0;
            const totalPhysical = Object.values(i.locations).reduce((a,b)=>a+b,0);
            
            if(opnameFilter==='diff') {
                // SELISIH: Tampilkan yang belum sesuai sysQty (qty total < atau > dari expected)
                return totalPhysical !== i.sysQty;
            }
            if(opnameFilter==='zero') {
                // BELUM: Tampilkan yang qty di box ini = 0 (belum dihitung) 
                return qtyInBox === 0;
            }
            // SEMUA: Tampilkan semua part yang ada di box ini
            return true;
        });
    } else {
        // Jika belum select box, tampilkan semua dengan filter global
        dataset = dataset.filter(i => {
            const total = Object.values(i.locations).reduce((a,b)=>a+b,0);
            if(opnameFilter==='diff') return total !== i.sysQty;
            if(opnameFilter==='zero') return total === 0;
            return true;
        });
    }
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
        
        // Location Badge 1 baris
        let locBadges = activeBoxFilter ? `<span class="loc-badge" style="font-size:0.7rem; padding:2px 6px;">Box ${activeBoxFilter}</span>` : Object.entries(i.locations).map(([k,v])=>`<span class="loc-badge" style="font-size:0.7rem; padding:2px 6px;">${k}(${v})</span>`).join('');
        
        const div = document.createElement('div'); div.className = `item-card ${(lastOpnameScanId === i.id) ? 'selected' : ''}`; div.id = `opname-row-${i.id}`;
        div.innerHTML = `
        <div style="flex:1" onclick="openEditModal(${i.id})">
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:4px;">
                <span class="part-code" style="font-size:1.05rem; font-weight:bold;">${i.partNo}</span>
                ${locBadges ? `<div style="display:flex; gap:4px; margin-left:auto; flex-wrap:wrap;">${locBadges}</div>` : ''}
            </div>
            <span class="part-desc" style="font-size:0.85rem; color:#64748b;">${i.desc}</span>
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-left:10px;">
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
    // Update box info display below input
    document.getElementById('opnameBoxInfo').style.display = 'block';
    document.getElementById('opnameBoxName').innerText = box;
    document.getElementById('activeBoxPanel').style.display = 'block'; 
    document.getElementById('opnameInfoPanel').style.display = 'none'; 
    document.getElementById('opnameList').style.display = 'flex'; 
    handleOpnameRender(); 
}
function clearOpnameBoxFilter() { 
    activeBoxFilter = null; 
    // Hide box info display when filter cleared
    document.getElementById('opnameBoxInfo').style.display = 'none';
    document.getElementById('activeBoxPanel').style.display = 'none'; 
    document.getElementById('opnameInfoPanel').style.display = 'none'; 
    document.getElementById('opnameList').style.display = 'flex'; 
    handleOpnameRender(); 
}
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
    if(q) dataset = dataset.filter(i => i.partNo.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q) || (i.locType && i.locType.toLowerCase().includes(q)));
    const show = dataset.slice(0, renderLimit); if(show.length===0) { container.innerHTML='<div style="text-align:center; padding:20px; color:#999">Tidak ditemukan</div>'; return; }
    let html = '';
    show.forEach(i => {
        const total = Object.values(i.locations).reduce((a,b)=>a+b,0); 
        // Location Badge 1 baris
        const locBadges = Object.entries(i.locations).map(([k,v])=>`<span class="loc-badge" style="font-size:0.7rem; padding:2px 6px;">${k}(${v})</span>`).join('');
        const opnameDate = i.lastOpnameDate ? new Date(i.lastOpnameDate).toLocaleDateString('id-ID', {year:'numeric', month:'short', day:'numeric'}) : '-';
        let color = total!==i.sysQty ? 'var(--danger)' : (total>0 ? 'var(--opname)' : 'var(--text)');
        let cardStyle = i.desc === 'PART BARU' ? 'border-left: 5px solid #ca8a04; background:#fffbeb;' : '';
        
        html += `<div class="item-card" id="data-row-${i.id}" onclick="openEditModal(${i.id})" style="${cardStyle}">
            <div style="flex:1;">
                <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:4px;">
                    <b style="font-size:1.05rem;">${i.partNo}</b> 
                    <span style="font-weight:bold; color:${color}; font-size:0.9rem; background:#f1f5f9; padding:2px 6px; border-radius:6px;">${total}/${i.sysQty}</span>
                    ${locBadges ? `<div style="display:flex; gap:4px; margin-left:auto; flex-wrap:wrap;">${locBadges}</div>` : ''}
                </div>
                <div style="font-size:0.8rem; color:var(--secondary); margin-bottom:4px;">${i.desc}</div>
                <div style="font-size:0.75rem; color:#666;"><i class="fas fa-calendar-alt"></i> Opname: ${opnameDate}</div>
            </div>
        </div>`;
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
    
    // Auto-set lastOpnameDate ONLY if from OPNAME tab
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    if (currentTab === 'opname') {
        const dateValue = item.lastOpnameDate ? item.lastOpnameDate.split('T')[0] : today;
        document.getElementById('editLastOpnameDate').value = dateValue;
        document.getElementById('editLastOpnameDate').parentElement.style.display = 'block';
    } else {
        document.getElementById('editLastOpnameDate').parentElement.style.display = 'none';
    }
    
    const list = document.getElementById('editLocsList'); list.innerHTML='';
    Object.keys(item.locations).forEach(box => { const r = document.createElement('div'); r.style.cssText="display:flex; justify-content:space-between; margin-bottom:8px; align-items:center;"; r.innerHTML=`<b>${box}</b> <div style="display:flex; gap:5px;"><input type="number" class="edit-qty-input" data-box="${box}" value="${item.locations[box]}" style="width:60px; padding:5px;"><button class="btn-trash" style="width:30px; height:30px;" onclick="deleteLocation(${id}, '${box}')"><i class="fas fa-trash"></i></button></div>`; list.appendChild(r); });
    document.getElementById('editDeleteBtnContainer').innerHTML = item.desc === 'PART BARU' ? `<button class="btn btn-danger" style="margin-top:15px;" onclick="deletePartBaru(${item.id})"><i class="fas fa-trash-alt"></i> Hapus Part Ini Permanen</button>` : '';
}

function deleteLocation(id, box) { if(confirm(`Hapus part ini dari box ${box}?`)) { const item = localItems.find(i=>i.id===id); if (item) { delete item.locations[box]; saveDB(item); feedback('success'); if(document.getElementById('editModal').style.display === 'flex') openEditModal(id); if(currentTab === 'opname') handleOpnameRender(); if(currentTab === 'data') renderDataList(false); } } }
function addManualLoc() { const box = document.getElementById('editNewBox').value.toUpperCase(); const qty = parseInt(document.getElementById('editNewQty').value); if (box && !isNaN(qty)) { const item = localItems.find(i => i.id === editId); item.locations[box] = qty || 0; saveDB(item); openEditModal(editId); } else { showToast("Box/Qty tak valid!"); } }
function saveManualEdit() { 
    const item = localItems.find(i=>i.id===editId); 
    document.querySelectorAll('.edit-qty-input').forEach(inp => { const v = parseInt(inp.value); if(!isNaN(v)) item.locations[inp.dataset.box]=v; }); 
    
    // Save lastOpnameDate ONLY if from OPNAME tab
    if (currentTab === 'opname') {
        const opnameDate = document.getElementById('editLastOpnameDate').value || new Date().toISOString().split('T')[0];
        item.lastOpnameDate = opnameDate;
    }
    
    saveDB(item); 
    document.getElementById('editModal').style.display='none'; 
    handleOpnameRender(); 
    renderDataList(false); 
    document.getElementById('mainInput').focus(); 
}
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
    // Clean up buffer when leaving SIMPAN tab
    if (currentTab === 'simpan' && currentTab !== id) {
        clearSimpanBuffer();
        targetBufferBox = null;
    }
    
    currentTab = id;
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
    document.getElementById('tab-'+id).classList.add('active');
    
    // Update sidebar items
    document.querySelectorAll('.sidebar-item').forEach(e=>e.classList.remove('active'));
    document.querySelector(`.sidebar-item[data-tab="${id}"]`)?.classList.add('active');
    
    // Update active tab title
    const tabTitles = {
        'simpan': { name: 'Penyimpanan', icon: 'fa-dolly' },
        'opname': { name: 'Inventory Check', icon: 'fa-clipboard-check' },
        'data': { name: 'Data', icon: 'fa-search' },
        'offbs': { name: 'Off BS', icon: 'fa-recycle' },
        'packing': { name: 'Packing', icon: 'fa-truck-loading' },
        'settings': { name: 'Pengaturan', icon: 'fa-cog' }
    };
    const tabInfo = tabTitles[id];
    if(tabInfo) {
        const titleEl = document.getElementById('activeTabTitle');
        const nameEl = document.getElementById('activeTabName');
        const iconEl = document.getElementById('activeTabIcon');
        if(nameEl) nameEl.textContent = tabInfo.name;
        if(iconEl) {
            iconEl.className = 'fas ' + tabInfo.icon;
        }
    }
    
    document.getElementById('scrollTopBtn').style.display = 'none';
    
    // Close sidebar drawer after selection
    toggleMenu();
}

// ============================================
// OPNAME BUFFER FUNCTIONS (Cashier Mode)
// ============================================

function addToOpnameBuffer(item) {
    // Check if item already in buffer
    const existing = opnameBuffer.find(b => b.item.id === item.id);
    if (existing) {
        existing.qty++;
        feedback('warning');
        showToast(`${item.partNo}: Qty +1 → ${existing.qty}`);
    } else {
        opnameBuffer.push({ item: item, qty: 1 });
        feedback('success');
        showToast(`${item.partNo}: Qty +1`);
    }
    renderOpnameBuffer();
    addHistoryLog(item.partNo, `Buffer +1`);
}

function processOpnameBuffer(boxCode) {
    if (opnameBuffer.length === 0) {
        feedback('error');
        showToast("Buffer kosong!");
        return;
    }

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    let processedCount = 0;
    let overQtyWarnings = [];

    opnameBuffer.forEach(bufferItem => {
        const item = bufferItem.item;
        const scannedQty = bufferItem.qty;

        // Initialize locations if not exists
        if (!item.locations[boxCode]) {
            item.locations[boxCode] = 0;
        }

        item.locations[boxCode] += scannedQty;

        // Always set opname date to today
        item.lastOpnameDate = today;

        saveDB(item);
        processedCount++;

        // Check for over-qty
        const totalPhysical = Object.values(item.locations).reduce((a, b) => a + b, 0);
        if (totalPhysical > item.sysQty) {
            overQtyWarnings.push({
                partNo: item.partNo,
                total: totalPhysical,
                target: item.sysQty,
                diff: totalPhysical - item.sysQty
            });
        }
    });

    // Feedback
    feedback('success');
    playChime();
    showToast(`✅ Box ${boxCode}: ${processedCount} part diproses!`);

    if (overQtyWarnings.length > 0) {
        const msg = overQtyWarnings.map(w => `${w.partNo}: ${w.total}/${w.target} (+${w.diff})`).join('\n');
        setTimeout(() => {
            alert(`⚠️ PERHATIAN: Over Qty!\n\n${msg}`);
        }, 500);
    }

    addHistoryLog(`Buffer→${boxCode}`, `${processedCount} items`);

    // Clear buffer and refresh UI
    clearOpnameBuffer();
    handleOpnameRender();
}

function renderOpnameBuffer() {
    const container = document.getElementById('opnameBufferTagsContainer');
    const countEl = document.getElementById('opnameBufferCount');
    const panel = document.getElementById('opnameBufferPanel');

    if (opnameBuffer.length === 0) {
        panel.style.display = 'none';
        container.innerHTML = '';
        countEl.textContent = '0';
        return;
    }

    panel.style.display = 'block';
    countEl.textContent = opnameBuffer.length;

    container.innerHTML = opnameBuffer.map((bufItem, idx) => {
        return `
            <div style="display:flex; align-items:center; gap:6px; background:#dcfce7; padding:8px 12px; border-radius:8px; border:1px solid #86efac; font-size:0.85rem; font-weight:bold; color:#14532d;">
                <span>${bufItem.item.partNo} × ${bufItem.qty}</span>
                <button onclick="removeFromOpnameBuffer(${idx})" style="background:none; border:none; color:#14532d; cursor:pointer; font-size:0.9rem; padding:0; width:20px; height:20px; display:flex; align-items:center; justify-content:center;">
                    <i class="fas fa-times-circle"></i>
                </button>
            </div>
        `;
    }).join('');
}

function removeFromOpnameBuffer(index) {
    if (index >= 0 && index < opnameBuffer.length) {
        const removed = opnameBuffer.splice(index, 1)[0];
        feedback('warning');
        showToast(`${removed.item.partNo} dihapus dari buffer`);
        renderOpnameBuffer();
    }
}

function clearOpnameBuffer() {
    if (opnameBuffer.length === 0) return;

    // Hapus popup confirm()
    opnameBuffer = [];
    opnameBufferBox = null;
    document.getElementById('opnameBufferPanel').style.display = 'none';
    document.getElementById('opnameBufferTagsContainer').innerHTML = '';
    document.getElementById('opnameBufferCount').textContent = '0';
    feedback('info');
    showToast('Buffer dihapus');
}

function showOpnameBufferPanel() {
    const panel = document.getElementById('opnameBufferPanel');
    panel.style.display = 'block';
    renderOpnameBuffer();
}

function clearData() { if(confirm('Hapus Semua?')) { const tx = db.transaction('items','readwrite'); tx.objectStore('items').clear(); tx.oncomplete = () => location.reload(); } }

// ============================================
// SIMPAN BUFFER FUNCTIONS (Cashier Mode)
// ============================================

function addToSimpanBuffer(item) {
    // Validate simpanBuffer is array
    if (!Array.isArray(simpanBuffer)) simpanBuffer = [];
    
    // Cek apakah item sudah ada di buffer
    const existing = simpanBuffer.find(b => b.item.id === item.id);
    
    tempPart = item;
    
    // Tampilkan deskripsi & peringatan (untuk info saja, tidak update panel lagi)
    let issueWarning = '';
    if (item.labelIssues && (item.labelIssues.DAMAGED > 0 || item.labelIssues.NO_LABEL > 0)) {
        let t = [];
        if (item.labelIssues.NO_LABEL > 0) t.push(`${item.labelIssues.NO_LABEL} Tanpa Label`);
        if (item.labelIssues.DAMAGED > 0) t.push(`${item.labelIssues.DAMAGED} Label Rusak`);
        issueWarning = `${t.join(' | ')}`;
    }

    // Tambah atau Update Qty Buffer - PURE SCAN COUNT ONLY (bukan DB qty)
    let scanQty;
    if (existing) {
        existing.qty++;  // Increment qty jika item sudah ada di buffer (pure scan count)
        scanQty = existing.qty;
        showToast(`${item.partNo} ➔ +${existing.qty} Scan`);
    } else {
        // NEW: Buffer qty = PURE SCAN COUNT ONLY (tidak termasuk DB qty)
        scanQty = 1;  // Hanya 1 scan untuk item baru
        const bufferItem = { item: item, qty: scanQty, hasConflict: false };
        
        // NEW: Detect conflict - compare item.lastBox vs targetBufferBox
        if (targetBufferBox && item.lastBox && item.lastBox !== '-' && item.lastBox !== targetBufferBox) {
            bufferItem.hasConflict = true;
            feedback('warning');  // Double-beep audio for conflict
            showToast(`⚠️ ${item.partNo} - Awal: ${item.lastBox}, Target: ${targetBufferBox}`);
        } else {
            showToast(`${item.partNo} ➔ +${scanQty} Scan`);
        }
        
        simpanBuffer.push(bufferItem);
    }
    
    // Hitung visualTotalQty untuk menentukan audio feedback
    const existingQtyInDB = Object.values(item.locations).reduce((a, b) => a + b, 0);
    const visualTotalQty = existingQtyInDB + scanQty;
    
    // Logika audio feedback berdasarkan total qty
    if (visualTotalQty < item.sysQty) {
        feedback('scan_normal');  // Beep standar, qty masih kurang
    } else if (visualTotalQty === item.sysQty) {
        feedback('scan_complete');  // Nada "Ding ding ting", qty pas sempurna
    } else {
        feedback('scan_over');  // Nada error, qty berlebih
    }
    
    // Highlight di List
    document.querySelectorAll('.item-card').forEach(el => { el.classList.remove('selected'); el.classList.remove('row-flash'); });
    const row = document.getElementById(`simpan-row-${item.id}`);
    if(row) { row.classList.add('selected'); row.classList.add('row-flash'); row.scrollIntoView({behavior:'smooth', block:'center'}); }

    // Update UI Panel
    renderSimpanBuffer();
    if(typeof renderSmartSuggestion === 'function') renderSmartSuggestion(item);
}

// ========== CONFLICT MODAL FUNCTIONS ==========

function showConflictModal(conflictedItems) {
    /**
     * Display modal dengan list item yang konflik (berbeda lokasi dari target box)
     * @param {Array} conflictedItems - Array of { item, qty, hasConflict }
     */
    const modal = document.getElementById('conflictModal');
    const container = document.getElementById('conflictListContainer');
    
    if (!modal || !container) {
        console.warn('❌ conflictModal atau conflictListContainer tidak ditemukan di HTML');
        return;
    }
    
    container.innerHTML = '';  // Clear previous list
    
    conflictedItems.forEach(bufferItem => {
        const { item, qty } = bufferItem;
        const lastBox = item.lastBox || '-';
        
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; align-items:center; gap:12px; padding:12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; margin-bottom:8px; flex-wrap:wrap;';
        
        div.innerHTML = `
            <div style="flex:1; min-width:150px;">
                <div style="font-weight:bold; font-size:1rem;">${item.partNo}</div>
                <div style="font-size:0.85rem; color:#64748b;">Awal: ${lastBox} → Target: ${targetBufferBox}</div>
                <div style="font-size:0.85rem; color:#64748b;">Qty: ${qty} pcs</div>
            </div>
            <div style="display:flex; gap:6px;">
                <button onclick="handleMove(${item.id}, '${targetBufferBox}')" style="padding:6px 12px; background:#3b82f6; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.85rem;">Pindah</button>
                <button onclick="handleSplit(${item.id}, '${targetBufferBox}')" style="padding:6px 12px; background:#8b5cf6; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.85rem;">Split</button>
                <button onclick="handleCancel(${item.id})" style="padding:6px 12px; background:#ef4444; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.85rem;">Batal</button>
            </div>
        `;
        
        container.appendChild(div);
    });
    
    // Add footer buttons
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; gap:12px; margin-top:16px; padding-top:12px; border-top:1px solid #e2e8f0; justify-content:flex-end;';
    footer.innerHTML = `
        <button onclick="forceSaveAllConflicts()" style="padding:8px 16px; background:#16a34a; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">✅ Simpan Semua</button>
        <button onclick="closeConflictModal()" style="padding:8px 16px; background:#6b7280; color:white; border:none; border-radius:6px; cursor:pointer;">Tutup</button>
    `;
    container.appendChild(footer);
    
    modal.style.display = 'flex';  // Show modal
    feedback('warning');
}

function handleMove(partId, newBox) {
    /**
     * Pindah item ke box baru: hapus dari lokasi lama, masukkan ke lokasi baru
     */
    const bufferItem = simpanBuffer.find(b => b.item.id === partId);
    if (!bufferItem) return;
    
    const item = bufferItem.item;
    
    // Clear old locations
    item.locations = {};
    
    // Set new location
    item.locations[newBox] = bufferItem.qty;
    item.lastBox = newBox;
    
    // Remove from buffer (moved to database)
    simpanBuffer = simpanBuffer.filter(b => b.item.id !== partId);
    
    // Save to database
    saveDB(item);
    feedback('success');
    showToast(`✅ ${item.partNo} dipindah ke ${newBox}`);
    
    // Refresh modal
    const remainingConflicts = simpanBuffer.filter(b => b.hasConflict);
    if (remainingConflicts.length > 0) {
        showConflictModal(remainingConflicts);
    } else {
        closeConflictModal();
        forceSaveAllConflicts();
    }
}

function handleSplit(partId, newBox) {
    /**
     * Split item: tambah qty ke box baru, jaga qty di box lama tetap ada
     */
    const bufferItem = simpanBuffer.find(b => b.item.id === partId);
    if (!bufferItem) return;
    
    const item = bufferItem.item;
    
    // Add new location (split lokasi)
    if (!item.locations[newBox]) {
        item.locations[newBox] = 0;
    }
    item.locations[newBox] += bufferItem.qty;
    
    // Keep old locations intact, update lastBox to new box
    item.lastBox = newBox;
    
    // Remove from buffer (moved to database)
    simpanBuffer = simpanBuffer.filter(b => b.item.id !== partId);
    
    // Save to database
    saveDB(item);
    feedback('success');
    showToast(`✅ ${item.partNo} di-split ke ${newBox} (total: ${Object.values(item.locations).reduce((a,b)=>a+b,0)} pcs)`);
    
    // Refresh modal
    const remainingConflicts = simpanBuffer.filter(b => b.hasConflict);
    if (remainingConflicts.length > 0) {
        showConflictModal(remainingConflicts);
    } else {
        closeConflictModal();
        forceSaveAllConflicts();
    }
}

function handleCancel(partId) {
    /**
     * Hapus item dari buffer tanpa menyimpan ke database
     */
    const bufferItem = simpanBuffer.find(b => b.item.id === partId);
    if (!bufferItem) return;
    
    simpanBuffer = simpanBuffer.filter(b => b.item.id !== partId);
    feedback('error');
    showToast(`❌ ${bufferItem.item.partNo} dibatalkan dari buffer`);
    
    // Refresh modal
    const remainingConflicts = simpanBuffer.filter(b => b.hasConflict);
    if (remainingConflicts.length > 0) {
        showConflictModal(remainingConflicts);
    } else {
        closeConflictModal();
    }
}

function closeConflictModal() {
    /**
     * Tutup modal konflik
     */
    const modal = document.getElementById('conflictModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function forceSaveAllConflicts() {
    /**
     * Simpan semua item di buffer ke database dengan targetBufferBox sebagai lokasi
     * Abaikan konfliks dan langsung pindahkan ke target box
     */
    simpanBuffer.forEach(bufferItem => {
        const item = bufferItem.item;
        
        // Clear old locations and set target box
        item.locations = {};
        item.locations[targetBufferBox] = bufferItem.qty;
        item.lastBox = targetBufferBox;
        
        // Save to database
        saveDB(item);
    });
    
    // Clear buffer
    simpanBuffer = [];
    targetBufferBox = null;
    
    // Close modal
    closeConflictModal();
    
    // Reset UI
    clearSimpanBuffer();
    renderSimpanList(true);
    
    feedback('success');
    showToast(`✅ Semua item tersimpan (${simpanBuffer.length} pcs)`);
}

function renderSimpanBuffer() {
    const statusPanel = document.getElementById('simpanStatusPanel');
    const itemsContainer = document.getElementById('simpanBufferItemsContainer');
    const countDisplay = document.getElementById('simpanBufferCountDisplay');
    const smartPanel = document.getElementById('smartSuggestionPanel');
    
    if (!Array.isArray(simpanBuffer) || simpanBuffer.length === 0) {
        statusPanel.style.display = 'none';
        if (itemsContainer) itemsContainer.innerHTML = '';
        if (countDisplay) countDisplay.textContent = '0';
        // Hide smart suggestion panel when buffer is empty
        if (smartPanel) smartPanel.style.display = 'none';
        return;
    }
    
    // Tampilkan panel
    statusPanel.style.display = 'block';
    if (countDisplay) countDisplay.textContent = simpanBuffer.length;
    
    // Render semua items di buffer
    let html = '';
    simpanBuffer.forEach((bufferItem, index) => {
        const item = bufferItem.item;
        const scanCount = bufferItem.qty;  // Pure scan count (not including DB qty)
        const dbQty = Object.values(item.locations).reduce((a, b) => a + b, 0);  // Existing DB qty
        const visualTotalQty = dbQty + scanCount;  // Total for UI display only
        const locList = Object.keys(item.locations || {}).join(', ') || 'Belum Box';
        const conflictBadge = bufferItem.hasConflict ? '<span style="background: rgba(255, 255, 255, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: bold;">⚠️ Konflik</span>' : '';
        
        // Tentukan status kuantitas dan class CSS berdasarkan visualTotalQty
        let statusClass = 'simpan-buffer-item';
        if (visualTotalQty < item.sysQty) {
            statusClass += ' buffer-kurang';
        } else if (visualTotalQty === item.sysQty) {
            statusClass += ' buffer-pas';
        } else {
            statusClass += ' buffer-lebih';
        }
        
        html += `
            <div class="${statusClass}">
                <div class="simpan-buffer-item-info">
                    <span class="simpan-buffer-item-part">${item.partNo}</span>
                    <button class="simpan-buffer-item-qty-edit" onclick="editBufferQty(${item.id})" title="Klik untuk edit jumlah scan">
                        x${visualTotalQty}/${item.sysQty} <i class="fas fa-pencil-alt"></i>
                    </button>
                    <span class="simpan-buffer-item-desc" title="${item.desc}">${item.desc}</span>
                    ${conflictBadge}
                </div>
                <span class="simpan-buffer-item-location" title="Lokasi Box">${locList}</span>
                <button class="simpan-buffer-item-remove" onclick="removeFromSimpanBuffer(${item.id})" title="Hapus dari buffer">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;
    });
    
    if (itemsContainer) itemsContainer.innerHTML = html;
}

function editBufferQty(itemId) {
    /**
     * Edit jumlah scan manual untuk item di buffer
     * @param {number} itemId - Item ID dari simpanBuffer
     */
    const bufferItem = simpanBuffer.find(b => b.item.id === itemId);
    if (!bufferItem) {
        feedback('error');
        showToast('Item tidak ditemukan di buffer');
        return;
    }
    
    const item = bufferItem.item;
    const currentScanQty = bufferItem.qty;
    const newQtyStr = prompt(`Masukkan jumlah scan manual untuk part ${item.partNo}:`, currentScanQty.toString());
    
    // Jika user cancel/tidak memasukkan, keluar
    if (newQtyStr === null || newQtyStr === '') {
        return;
    }
    
    const newQty = parseInt(newQtyStr);
    
    // Validasi input
    if (isNaN(newQty) || newQty < 0) {
        feedback('error');
        showToast('Masukkan angka yang valid (>= 0)');
        return;
    }
    
    // Update qty di buffer
    bufferItem.qty = newQty;
    
    // Hitung ulang visualTotalQty
    const dbQty = Object.values(item.locations).reduce((a, b) => a + b, 0);
    const visualTotalQty = dbQty + newQty;
    
    // Trigger audio feedback berdasarkan status qty baru
    if (visualTotalQty < item.sysQty) {
        feedback('scan_normal');
    } else if (visualTotalQty === item.sysQty) {
        feedback('scan_complete');
    } else {
        feedback('scan_over');
    }
    
    // Update UI dan tampilkan toast
    showToast(`${item.partNo} diubah menjadi ${newQty} scan`);
    renderSimpanBuffer();
}

function removeFromSimpanBuffer(itemId) {
    const index = simpanBuffer.findIndex(b => b.item.id === itemId);
    if (index !== -1) {
        const removed = simpanBuffer.splice(index, 1)[0];
        feedback('warning');
        showToast(`${removed.item.partNo} dihapus dari buffer`);
        renderSimpanBuffer();
        
        // Update highlight di list
        const row = document.getElementById(`simpan-row-${itemId}`);
        if (row) row.classList.remove('selected');
    }
}

function clearSimpanBuffer() {
    // Validate simpanBuffer exists and is array
    if (!Array.isArray(simpanBuffer)) simpanBuffer = [];
    simpanBuffer = [];
    simpanBufferBox = null;
    tempPart = null;
    
    const statusPanel = document.getElementById('simpanStatusPanel');
    const itemsContainer = document.getElementById('simpanBufferItemsContainer');
    const countDisplay = document.getElementById('simpanBufferCountDisplay');
    const smartPanel = document.getElementById('smartSuggestionPanel');
    
    if (statusPanel) statusPanel.style.display = 'none';
    if (itemsContainer) itemsContainer.innerHTML = '';
    if (countDisplay) countDisplay.textContent = '0';
    // Hide smart suggestion panel when buffer is cleared
    if (smartPanel) smartPanel.style.display = 'none';
    
    document.querySelectorAll('.item-card').forEach(el => el.classList.remove('selected'));
}

function showSimpanBufferPanel() {
    const panel = document.getElementById('multiScanPanel');
    panel.style.display = 'block';
    renderSimpanBuffer();
}