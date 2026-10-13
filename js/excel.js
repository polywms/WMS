/*
 * Tujuan: Import, export, backup, dan restore data WMS melalui file Excel/JSON.
 * Caller: Tombol data/settings di index.html.
 * Dependensi: SheetJS, database.js (IndexedDB/sync), dan UI utilities.
 * Main Functions: handleImport() refreshes stock qty without replacing saved locations and reconciles server IDs; exportData(), backupJson(), restoreJson(), import harga.
 * Side Effects: Membaca file, menulis IndexedDB/cloud dan waktu upload ke localStorage, mengunduh file, dan reload aplikasi.
 */

function handleImport(input) {
    if (!requireAdminAccess('mengimpor data stock')) {
        input.value = '';
        return;
    }
    const f = input.files[0]; 
    if(!f) return;
    showLoading('<i class="fas fa-download"></i> Import Stock', `Membaca file: ${f.name}`);
    const r = new FileReader();
    r.onload = async e => {
        showLoading('<i class="fas fa-download"></i> Import Stock', 'Memproses data...');
        updateSyncUI('<i class="fas fa-spinner fa-spin"></i> Membaca Excel...');
        const wb = XLSX.read(e.target.result, {type:'array'});
        const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {defval:''});
        
        const txRead = db.transaction('items', 'readonly');
        const oldItems = await new Promise(resolve => { txRead.objectStore('items').getAll().onsuccess = ev => resolve(ev.target.result || []); });
        
        const oldItemsByKey = new Map();
        oldItems.forEach(item => {
            const key = getWmsItemIdentityKey(item);
            if (!oldItemsByKey.has(key)) oldItemsByKey.set(key, item);
        });
        
        const consolidatedExcel = {}; let fgSkippedCount = 0;
        json.forEach(row => {
            const rawPartNo = String(row['Part']||row['Nomor Gudang']||'').trim(); const pNo = rawPartNo.toUpperCase();
            if (!pNo) return; 
            const locType = (row['Tipe Lokasi']||'UMUM').trim();
            if (locType.toUpperCase().startsWith('FG')) { fgSkippedCount++; return; } // Filter FG

            const techName = String(row['Nama']||'').trim(); const qty = parseInt(row['Available QTY']||0) || 0;
            const compositeKey = getWmsItemIdentityKey({ partNo: pNo, locType, techName });
            
            if (consolidatedExcel[compositeKey]) { consolidatedExcel[compositeKey].sysQty += qty; } 
            else { consolidatedExcel[compositeKey] = { locType: locType, techName: techName, partNo: rawPartNo, desc: row['Deskripsi Part']||'', sysQty: qty, raw: row, compositeKey: compositeKey }; }
        });
        
        const tx = db.transaction('items', 'readwrite');
        const st = tx.objectStore('items');
        const importedKeys = new Set(Object.keys(consolidatedExcel));
        const bulkDataToUpload = [];
        let newPartCount = 0;
        let newIdCounter = 0;

        Object.entries(consolidatedExcel).forEach(([key, data]) => {
            const existingItem = oldItemsByKey.get(key);
            let item;
            if (existingItem) {
                item = { ...existingItem, sysQty: data.sysQty, updated_at: Date.now() };
            } else {
                item = {
                    id: Date.now() + newIdCounter++,
                    locType: data.locType,
                    techName: data.techName,
                    partNo: data.partNo,
                    desc: data.desc,
                    sysQty: data.sysQty,
                    updated_at: Date.now(),
                    locations: {},
                    opnameCounts: {},
                    raw: data.raw,
                    lastOpnameDate: ''
                };
                newPartCount++;
            }
            st.put(item);
            bulkDataToUpload.push(item);
        });

        const rescuedCount = oldItems.filter(item => !importedKeys.has(getWmsItemIdentityKey(item))).length;
        
        tx.oncomplete = async () => {
            try {
                updatePendingStockQuantities(bulkDataToUpload);
            } catch (queueError) {
                await loadDataFromLocal();
                hideLoading();
                alert(`Import lokal selesai, tetapi antrean upload gagal diperbarui: ${queueError instanceof Error ? queueError.message : String(queueError)}. Jangan upload antrean lama; ulangi import sebelum sinkronisasi.`);
                return;
            }
            showLoading('<i class="fas fa-download"></i> Import Stock', 'Mengirim ke cloud...');
            updateSyncUI('<i class="fas fa-paper-plane"></i> Mengirim ke Cloud (Mohon Tunggu)...');
            try {
                const response = await postWmsAction({ action: "bulk_import", data: bulkDataToUpload, logs: [{ partNo: "SEMUA", action: "IMPORT EXCEL", detail: `Import ${bulkDataToUpload.length} Baris Data` }] });
                const responseText = await response.text();
                let result;
                try {
                    result = JSON.parse(responseText);
                } catch {
                    const contentType = response.headers.get('content-type') || 'unknown content type';
                    const preview = responseText.replace(/\s+/g, ' ').slice(0, 180);
                    const deploymentHint = response.status === 404
                        ? ' URL/deployment Web App Apps Script tidak ditemukan; periksa URL deployment terbaru dan aksesnya.'
                        : ` Cuplikan respons: ${preview || '(kosong)'}`;
                    throw new Error(`Endpoint Cloud mengembalikan respons bukan JSON (HTTP ${response.status}, ${contentType}).${deploymentHint}`);
                }
                if (!response.ok || result.status !== "success") {
                    throw new Error(result.message || `Server tidak mengonfirmasi upload (HTTP ${response.status}).`);
                }
                if (bulkDataToUpload.length > 0
                    && (!Array.isArray(result.idMappings)
                        || result.idMappings.length !== bulkDataToUpload.length
                        || result.idMappings.some(mapping => !mapping
                            || mapping.clientId === undefined
                            || mapping.id === undefined
                            || mapping.key === undefined))) {
                    throw new Error('Server belum mengirim pemetaan ID lengkap. Deploy code.gs terbaru sebelum melanjutkan sinkronisasi.');
                }
                if (Array.isArray(result.idMappings) && result.idMappings.length > 0) {
                    try {
                        await reconcileStockImportIds(result.idMappings);
                    } catch (reconcileError) {
                        hideLoading();
                        alert(`Import Cloud berhasil, tetapi sinkronisasi ID lokal gagal: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}. Jangan jalankan sinkronisasi antrean sebelum masalah ini diperiksa.`);
                        return;
                    }
                }
                localStorage.setItem('lastStockUploadAt', new Date().toISOString());
                hideLoading();
                alert(`IMPORT & SYNC SELESAI!\nDATA BERHASIL MASUK GOOGLE SHEETS.\n${newPartCount} part baru ditambahkan.\n${rescuedCount} part lokal yang tidak ada di Excel dipertahankan.\n${fgSkippedCount} Baris 'FG' dibuang.`);
            } catch (err) { hideLoading(); alert(`Import Lokal Selesai, tapi upload ke Cloud gagal: ${err instanceof Error ? err.message : String(err)}`); }
            location.reload(); 
        };
    }; 
    r.readAsArrayBuffer(f);
}

function updatePendingStockQuantities(importedItems) {
    const importedByKey = new Map(importedItems.map(item => [getWmsItemIdentityKey(item), item]));
    const updatedQueue = syncQueue.map(queuedItem => {
        const importedItem = importedByKey.get(getWmsItemIdentityKey(queuedItem));
        return importedItem
            ? { ...queuedItem, sysQty: importedItem.sysQty, updated_at: importedItem.updated_at }
            : queuedItem;
    });
    localStorage.setItem('wms_syncQueue', JSON.stringify(updatedQueue));
    syncQueue = updatedQueue;
}

async function reconcileStockImportIds(idMappings) {
    const byClientId = new Map(idMappings.map(mapping => [String(mapping.clientId), mapping]));
    const records = await new Promise((resolve, reject) => {
        const request = db.transaction('items', 'readonly').objectStore('items').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Gagal membaca data lokal untuk rekonsiliasi ID.'));
    });
    const changed = [];
    const finalIds = new Set();
    records.forEach(item => {
        const mapping = byClientId.get(String(item.id));
        const nextItem = mapping && mapping.key === getWmsItemIdentityKey(item)
            ? { ...item, id: mapping.id }
            : item;
        const finalId = String(nextItem.id);
        if (finalIds.has(finalId)) {
            throw new Error(`ID lokal ${finalId} bertabrakan setelah pemetaan server.`);
        }
        finalIds.add(finalId);
        if (nextItem.id !== item.id) changed.push({ oldId: item.id, item: nextItem });
    });
    if (changed.length === 0) return;

    await new Promise((resolve, reject) => {
        let tx;
        try {
            tx = db.transaction('items', 'readwrite');
            const store = tx.objectStore('items');
            changed.forEach(entry => store.delete(entry.oldId));
            changed.forEach(entry => store.put(entry.item));
        } catch (error) {
            reject(error);
            return;
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan pemetaan ID server.'));
        tx.onabort = () => reject(tx.error || new Error('Rekonsiliasi ID lokal dibatalkan.'));
    });

    syncQueue = syncQueue.map(queuedItem => {
        const mapping = byClientId.get(String(queuedItem.id));
        if (!mapping || mapping.key !== getWmsItemIdentityKey(queuedItem)) return queuedItem;
        const currentItem = records.find(item => getWmsItemIdentityKey(item) === mapping.key);
        return currentItem ? { ...currentItem, id: mapping.id } : { ...queuedItem, id: mapping.id };
    });
    localStorage.setItem('wms_syncQueue', JSON.stringify(syncQueue));
}

function exportData() {
    if (!requireAdminAccess('mengekspor data')) return;
    showLoading("<i class='fas fa-arrow-up'></i> Export Data", "Mempersiapkan file...");
    
    // ===== FLATTENED FORMAT: Satu baris per lokasi =====
    const flattenedData = [];
    
    localItems.filter(i => i.desc !== 'PART BARU').forEach(item => {
        const hasLocations = item.locations && Object.keys(item.locations).length > 0;
        
        if (hasLocations) {
            // Jika ada lokasi, buat satu baris per lokasi
            Object.entries(item.locations).forEach(([lokasi, qty]) => {
                flattenedData.push({
                    'Part Number': item.partNo,
                    'Deskripsi': item.desc || '',
                    'Kategori Lokasi': item.locType || '',
                    'Nama Teknisi': item.techName || '',
                    'Qty Sistem': item.sysQty || 0,
                    'Lokasi': lokasi,
                    'Qty Hitung': qty,
                    'Harga': item.harga || 0
                });
            });
        } else {
            // Jika tidak ada lokasi, tampilkan 1 baris dengan lokasi & qty kosong
            flattenedData.push({
                'Part Number': item.partNo,
                'Deskripsi': item.desc || '',
                'Kategori Lokasi': item.locType || '',
                'Nama Teknisi': item.techName || '',
                'Qty Sistem': item.sysQty || 0,
                'Lokasi': '',
                'Qty Hitung': '',
                'Harga': item.harga || 0
            });
        }
    });
    
    // ===== Part Temuan (Baru) - Format Flattened =====
    const dataBaru = [];
    localItems.filter(i => i.desc === 'PART BARU').forEach(item => {
        const hasLocations = item.locations && Object.keys(item.locations).length > 0;
        
        if (hasLocations) {
            Object.entries(item.locations).forEach(([lokasi, qty]) => {
                dataBaru.push({
                    'Part Number': item.partNo,
                    'Lokasi Ditemukan': lokasi,
                    'Qty Ditemukan': qty,
                    'Harga': item.harga || 0,
                    'Tanggal Ditemukan': item.lastOpnameDate || '-'
                });
            });
        } else {
            dataBaru.push({
                'Part Number': item.partNo,
                'Lokasi Ditemukan': '',
                'Qty Ditemukan': '',
                'Harga': item.harga || 0,
                'Tanggal Ditemukan': item.lastOpnameDate || '-'
            });
        }
    });
    
    // ===== Generate Excel File =====
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flattenedData), "Data Master");
    if (dataBaru.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dataBaru), "Part Temuan (Baru)");
    XLSX.writeFile(wb, "WMS_Result.xlsx");
    hideLoading();
}

// Helper perbaikan Tahun 1899 untuk waktu (Supaya Excel baca YYYY-MM-DD HH:MM:SS)
function formatExcelTime(isoTime) {
    if (!isoTime) return "";
    try {
        // Jika waktu ditarik dari Cloud dan mengandung epoch 1899, ambil jamnya saja
        if (typeof isoTime === 'string' && isoTime.includes('1899-12-30')) {
            const d = new Date(isoTime);
            return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/\./g, ':');
        }
        
        // Parsing tanggal normal
        const d = new Date(isoTime);
        if (!isNaN(d.getTime())) {
            const pad = n => n.toString().padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }
        
        // Fallback jika format lama (seperti "14.30.45") terlanjur masuk
        if (typeof isoTime === 'string' && isoTime.includes('.')) {
            return isoTime.replace(/\./g, ':'); // Ubah 14.30.45 jadi 14:30:45
        }
        
        return isoTime;
    } catch(e) { 
        return isoTime; 
    }
}

function exportOffBsData() {
    if (offBsSession.length === 0) { alert("Belum ada data!"); return; }
    const hiddenBoxes = typeof hiddenOffBsBoxes !== 'undefined' ? hiddenOffBsBoxes : [];
    const visibleData = offBsSession.filter(item => !hiddenBoxes.includes(item.box));
    if (visibleData.length === 0) { alert("Pastikan sudah mencentang Box di tombol Filter!"); return; }
    
    const dataToExport = visibleData.map((item, index) => {
        // Lookup deskripsi part dari localItems
        const masterItem = localItems.find(i => i.partNo.trim().toUpperCase() === item.partNo.trim().toUpperCase());
        const deskripsi = masterItem ? masterItem.desc : '-';
        
        return {
            "No": visibleData.length - index,
            "Waktu Scan": formatExcelTime(item.time), // <--- BUG 1899 FIXED
            "Kode Box/Colly": item.box,
            "Part Number": item.partNo,
            "Deskripsi Part": deskripsi,
            "QTY Fisik": item.qty,
            "Doc Number (SJOB)": item.docNo,
            "QR Text Raw": item.qr
        };
    });
    
    const ws = XLSX.utils.json_to_sheet(dataToExport);
    ws['!cols'] = [{wch: 5}, {wch: 22}, {wch: 25}, {wch: 25}, {wch: 35}, {wch: 10}, {wch: 35}, {wch: 60}];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Temp OFF BS");
    const dStr = new Date().toISOString().slice(0,10).replace(/-/g, ''); const tStr = new Date().toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'}).replace(/:/g, '');
    XLSX.writeFile(wb, `Packing_OFFBS_${dStr}_${tStr}.xlsx`);
}

// EKSPOR KHUSUS PACKING (BARU)
window.exportPackingData = function() {
    if (typeof packingSession === 'undefined' || packingSession.length === 0) { alert("Belum ada data Packing di sesi ini!"); return; }
    const dataToExport = packingSession.map((item, index) => ({
        "No": packingSession.length - index,
        "Waktu Packing": formatExcelTime(item.time),
        "Colly Pengiriman": item.colly,
        "Part Number": item.partNo,
        "QTY Fisik": item.qty,
        "Doc Number (SJOB)": item.docNo,
        "QR Text Raw": item.qr
    }));
    const ws = XLSX.utils.json_to_sheet(dataToExport);
    ws['!cols'] = [{wch: 5}, {wch: 22}, {wch: 25}, {wch: 25}, {wch: 10}, {wch: 35}, {wch: 60}];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Colly Pengiriman");
    const dStr = new Date().toISOString().slice(0,10).replace(/-/g, ''); const tStr = new Date().toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'}).replace(/:/g, '');
    XLSX.writeFile(wb, `Pengiriman_Colly_${dStr}_${tStr}.xlsx`);
}

function downloadNewParts() {
    if (!requireAdminAccess('mengunduh daftar part baru')) return;
    const newParts = localItems.filter(i => i.desc === 'PART BARU'); if(newParts.length === 0) { alert('Tidak ada.'); return; }
    const ws = XLSX.utils.json_to_sheet(newParts.map(i => ({ 'Part Number': i.partNo, 'Lokasi': Object.keys(i.locations).join(', '), 'Status': 'Perlu Update Nama' })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Part Baru"); XLSX.writeFile(wb, "Daftar_Part_Baru.xlsx");
}

function exportLabelReport() {
    if (!requireAdminAccess('mengekspor laporan label')) return;
    const data = [];
    localItems.forEach(i => { if (i.labelIssues && (i.labelIssues.DAMAGED > 0 || i.labelIssues.NO_LABEL > 0)) data.push({ 'Part Number': i.partNo, 'Deskripsi Part': i.desc, 'Qty Tanpa Label': i.labelIssues.NO_LABEL || 0, 'Qty Label Rusak': i.labelIssues.DAMAGED || 0, 'Terdeteksi di Box': Object.keys(i.locations).join(', ') || 'Belum masuk Box' }); });
    if(data.length === 0) { alert('Tidak ada data!'); return; }
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Laporan Label"); XLSX.writeFile(wb, "Laporan_Label_Bermasalah.xlsx");
}

function backupJson() {
    if (!requireAdminAccess('membuat backup lokasi')) return;
    showLoading("<i class='fas fa-save'></i> Backup JSON", "Mempersiapkan file...");
    const b = new Blob([JSON.stringify(localItems.map(i => ({ partNo: i.partNo, locations: i.locations, harga: i.harga || 0 })))], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `Mapping_Lokasi_${new Date().toISOString().slice(0,10)}.json`; a.click();
    setTimeout(hideLoading, 500);
}

function restoreJson(input) {
    if (!requireAdminAccess('memulihkan backup')) {
        input.value = '';
        return;
    }
    const f = input.files[0]; if(!f) return;
    if(!confirm("Restore JSON hanya memperbarui harga. Lokasi fisik tidak dipulihkan dan hanya dapat dipindahkan melalui scan SIMPAN.\nLanjutkan?")) { input.value = ''; return; }
    showLoading("<i class='fas fa-folder-open'></i> Restore JSON", `Membaca file: ${f.name}`);
    const r = new FileReader(); 
    r.onload = e => {
        showLoading("<i class='fas fa-folder-open'></i> Restore JSON", "Memproses data...");
        const backupData = JSON.parse(e.target.result); const tx = db.transaction('items','readwrite'); const st = tx.objectStore('items'); 
        st.getAll().onsuccess = ev => {
            const currentItems = ev.target.result || []; let updateCount = 0;
            backupData.forEach(backupItem => {
                const existingItem = currentItems.find(i => i.partNo === backupItem.partNo);
                if (existingItem) { 
                    if (backupItem.harga !== undefined) existingItem.harga = backupItem.harga;
                    st.put(existingItem); 
                    updateCount++; 
                }
            });
            tx.oncomplete = () => { hideLoading(); alert(`RESTORE SELESAI!\n${updateCount} part diperbarui. Lokasi fisik dipertahankan; pemindahan hanya melalui scan SIMPAN.`); location.reload(); };
        };
    }; r.readAsText(f);
}

// ===== IMPORT HARGA FILE =====
// js/excel.js - handleImportHarga(input)
// Tujuan: Baca file Excel berisi kolom "Nomor Gudang", "Nama Sparepart", "Harga"
// Cari part di localItems, update properti harga, simpan ke IndexedDB & kirim ke cloud
// Side Effect: Modifikasi item.harga, saveDB(), POST ke API_URL dengan action "import_harga"
function handleImportHarga(input) {
    if (!requireAdminAccess('mengimpor harga')) {
        input.value = '';
        return;
    }
    const f = input.files[0];
    if (!f) return;
    
    showLoading("<i class='fas fa-tags'></i> Import Harga", `Membaca file: ${f.name}`);
    const r = new FileReader();
    r.onload = async e => {
        try {
            showLoading("<i class='fas fa-tags'></i> Import Harga", "Memproses data...");
            updateSyncUI('<i class="fas fa-spinner fa-spin"></i> Membaca File Harga...');
            
            const wb = XLSX.read(e.target.result, {type:'array'});
            const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {defval:''});
            
            // Parse data dari Excel: header adalah "Nomor Gudang", "Nama Sparepart", "Harga"
            const hargaData = json.map(row => ({
                partNo: String(row['Nomor Gudang'] || row['Part Number'] || row['Part'] || '').trim(),
                desc: String(row['Nama Sparepart'] || row['Deskripsi'] || '').trim(),
                harga: parseInt(row['Harga'] || row['Price'] || 0) || 0
            })).filter(d => d.partNo); // Hanya ambil yang ada partNo-nya
            
            if (hargaData.length === 0) {
                hideLoading();
                alert("PERINGATAN: Tidak ada data harga ditemukan di file!");
                input.value = '';
                updateSyncUI('<i class="fas fa-circle" style="color: #22c55e; font-size: 0.6rem; margin-right: 4px;"></i> Siap');
                return;
            }
            
            // Proses update harga di localItems
            let updatedCount = 0;
            let notFoundCount = 0;
            const updatedParts = [];
            
            const tx = db.transaction('items', 'readwrite');
            const st = tx.objectStore('items');
            
            hargaData.forEach(harItem => {
                // Cari part di localItems berdasarkan partNo
                const foundItem = localItems.find(i => i.partNo.trim().toUpperCase() === harItem.partNo.toUpperCase());
                
                if (foundItem) {
                    // Update harga
                    foundItem.harga = harItem.harga;
                    st.put(foundItem);
                    updatedCount++;
                    updatedParts.push({
                        partNo: foundItem.partNo,
                        harga: harItem.harga,
                        desc: foundItem.desc
                    });
                } else {
                    notFoundCount++; // Abaikan, tidak ada di database lokal
                }
            });
            
            tx.oncomplete = async () => {
                showLoading("<i class='fas fa-tags'></i> Import Harga", `Mengirim ${updatedCount} data ke cloud...`);
                updateSyncUI('<i class="fas fa-paper-plane"></i> Mengirim Harga ke Cloud...');
                
                try {
                    // Kirim ke Google Apps Script
                    const response = await postWmsAction({
                        action: "import_harga",
                        data: updatedParts,
                        timestamp: Date.now()
                    });
                    
                    const result = await response.json();
                    hideLoading();
                    
                    if (result.status === "success") {
                        alert(`IMPORT HARGA SELESAI!\n\n${updatedCount} Part berhasil di-update harganya\n${notFoundCount} Part tidak ditemukan (diabaikan)\nData sudah tersimpan lokal & cloud`);
                    } else {
                        alert(`PERHATIAN: Import Lokal Selesai (${updatedCount} part)!\nTapi upload ke cloud: ${result.message}`);
                    }
                    
                    input.value = '';
                    updateSyncUI('<i class="fas fa-circle" style="color: #22c55e; font-size: 0.6rem; margin-right: 4px;"></i> Siap');
                    location.reload();
                } catch (err) {
                    hideLoading();
                    console.error('Import Harga Cloud Error:', err);
                    alert(` SUKSES: Harga sudah tersimpan lokal (${updatedCount} part)!\nPERHATIAN: Tapi gagal upload ke cloud: ${err.message}`);
                    input.value = '';
                    updateSyncUI('<i class="fas fa-exclamation-triangle"></i> Warning');
                    setTimeout(() => location.reload(), 2000);
                }
            };
        } catch (err) {
            hideLoading();
            console.error('Import Harga Error:', err);
            alert(`GAGAL: Gagal membaca file: ${err.message}`);
            input.value = '';
            updateSyncUI('<i class="fas fa-times-circle"></i> Error');
        }
    };
    
    r.readAsArrayBuffer(f);
}

// ===== IMPORT OFF BS FILE =====
function handleImportOffBS(input) {
    if (!requireAdminAccess('mengimpor data OFF BS')) {
        input.value = '';
        return;
    }
    const f = input.files[0]; 
    if(!f) return;
    
    if(!confirm("Import OFF BS akan mengirim semua data ke sheet Master_Off_BS di Google Sheets (timpa).\n\nLanjutkan?")) {
        input.value = '';
        return;
    }
    
    showLoading('<i class="fas fa-download"></i> Import OFF BS', `Membaca file: ${f.name}`);
    const r = new FileReader();
    r.onload = async e => {
        updateSyncUI('<i class="fas fa-spinner fa-spin"></i> Membaca File OFF BS...');
        
        try {
            const wb = XLSX.read(e.target.result, {type:'array'});
            const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {defval:''});
            
            // Filter hanya RECEIPT transactions
            const offBsData = json
                .filter(row => {
                    const tipeTransaksi = String(row['Tipe Transaksi'] || '').trim().toUpperCase();
                    return tipeTransaksi === 'RECEIPT';
                })
                .map(row => ({
                    nomor: row['Nomor'] || '',
                    kodePerusahaan: row['Kode Perusahaan'] || '',
                    site: row['Site'] || '',
                    departemen: row['Departemen'] || '',
                    nomorReservasi: row['Nomor Reservasi'] || '',
                    kodeTranaksi: row['Kode Transaksi'] || '',
                    tipeTranaksi: row['Tipe Transaksi'] || '',
                    catatan: row['Catatan'] || '',
                    baris: row['Baris'] || '',
                    part: row['Part'] || '',
                    lot: row['Lot'] || '',
                    attribute: row['Attribute'] || '',
                    qtyReservasi: parseInt(row['Qty Reservasi']) || 0,
                    qtyTransaksi: parseInt(row['Qty Transaksi']) || 0,
                    qtyClose: parseInt(row['Qty Close']) || 0,
                    uom: row['UoM'] || '',
                    serialNumber: row['Serial Number'] || '',
                    statusReservasi: row['Status Reservasi'] || '',
                    statusPengiriman: row['Status Pengiriman'] || '',
                    dibuatOleh: row['Dibuat Oleh'] || '',
                    dibuatPada: row['Dibuat Pada'] || '',
                    diubahOleh: row['Diubah Oleh'] || '',
                    diubahPada: row['Diubah Pada'] || '',
                    ditetapkanOleh: row['Disetujui Oleh'] || '',
                    disetujuiPada: row['Disetujui Pada'] || '',
                    returnToFactory: row['Return To Factory'] || '',
                    claimToFactory: row['Claim To Factory'] || '',
                    teknisiPerbaikan: row['Teknisi Perbaikan'] || '',
                    analisa: row['Analisa SA'] || '',
                    keterangan: row['Keterangan Sjob'] || ''
                }));
            
            if (offBsData.length === 0) {
                hideLoading();
                alert("PERINGATAN: Tidak ada data RECEIPT yang ditemukan di file!");
                input.value = '';
                updateSyncUI('<i class="fas fa-circle" style="color: #22c55e; font-size: 0.6rem; margin-right: 4px;"></i> Siap');
                return;
            }
            
            showLoading('<i class="fas fa-download"></i> Import OFF BS', `Mengirim ${offBsData.length} baris ke cloud...`);
            updateSyncUI(`<i class="fas fa-paper-plane"></i> Mengirim ${offBsData.length} Data OFF BS ke Cloud...`);
            
            const response = await postWmsAction({
                action: "import_off_bs",
                data: offBsData,
                timestamp: Date.now()
            });
            
            const result = await response.json();
            
            if (result.status === "success") {
                hideLoading();
                alert(`IMPORT OFF BS SELESAI!\n\nData yang diimpor: ${offBsData.length} baris\nSheet Master_Off_BS sudah diperbarui di Google Sheets`);
                input.value = '';
                updateSyncUI('<i class="fas fa-circle" style="color: #22c55e; font-size: 0.6rem; margin-right: 4px;"></i> Siap');
            } else {
                hideLoading();
                alert(`GAGAL: ${result.message}`);
                input.value = '';
                updateSyncUI('<i class="fas fa-times-circle"></i> Error');
            }
        } catch (err) {
            hideLoading();
            console.error('Import OFF BS Error:', err);
            alert(`GAGAL: Gagal membaca file atau mengirim ke cloud: ${err.message}`);
            input.value = '';
            updateSyncUI('<i class="fas fa-times-circle"></i> Error');
        }
    };
    
    r.readAsArrayBuffer(f);
}