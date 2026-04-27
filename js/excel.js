// js/excel.js

function handleImport(input) {
    const f = input.files[0]; 
    if(!f) return;
    showLoading("📥 Import Stock", `Membaca file: ${f.name}`);
    const r = new FileReader();
    r.onload = async e => {
        showLoading("📥 Import Stock", "Memproses data...");
        updateSyncUI("🔄 Membaca Excel...");
        const wb = XLSX.read(e.target.result, {type:'array'});
        const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {defval:''});
        
        const txRead = db.transaction('items', 'readonly');
        const oldItems = await new Promise(resolve => { txRead.objectStore('items').getAll().onsuccess = ev => resolve(ev.target.result || []); });
        
        const locationPool = {}; const idMap = {}; 
        oldItems.forEach(item => {
            const pNo = item.partNo.trim().toUpperCase();
            if (Object.keys(item.locations).length > 0) { if (!locationPool[pNo]) locationPool[pNo] = {}; Object.assign(locationPool[pNo], item.locations); }
            idMap[`${pNo}_${(item.locType||'').toUpperCase()}_${(item.techName||'').toUpperCase()}`] = item.id;
        });
        
        const consolidatedExcel = {}; let fgSkippedCount = 0;
        json.forEach(row => {
            const rawPartNo = String(row['Part']||row['Nomor Gudang']||'').trim(); const pNo = rawPartNo.toUpperCase();
            if (!pNo) return; 
            const locType = (row['Tipe Lokasi']||'UMUM').trim();
            if (locType.toUpperCase().startsWith('FG')) { fgSkippedCount++; return; } // Filter FG

            const techName = (row['Nama']||'').trim(); const qty = parseInt(row['Available QTY']||0) || 0;
            const compositeKey = `${pNo}_${locType.toUpperCase()}_${techName.toUpperCase()}`;
            
            if (consolidatedExcel[compositeKey]) { consolidatedExcel[compositeKey].sysQty += qty; } 
            else { consolidatedExcel[compositeKey] = { locType: locType, techName: techName, partNo: rawPartNo, desc: row['Deskripsi Part']||'', sysQty: qty, raw: row, basePartNo: pNo, compositeKey: compositeKey }; }
        });
        
        for (const pNo in locationPool) {
            const hasNonTeknisi = Object.values(consolidatedExcel).some(d => d.basePartNo === pNo && !d.locType.toUpperCase().includes('TEKNISI'));
            if (!hasNonTeknisi && Object.keys(locationPool[pNo]).length > 0) {
                const dummyKey = `${pNo}_SPAREPART BAIK_`;
                consolidatedExcel[dummyKey] = { locType: 'SPAREPART BAIK', techName: '', partNo: pNo, desc: 'PART MIGRASI (CEK EXCEL)', sysQty: 0, raw: {}, basePartNo: pNo, compositeKey: dummyKey };
            }
        }
        
        const excelPartSet = new Set(Object.values(consolidatedExcel).map(d => d.basePartNo));
        const localPartsOnly = oldItems.filter(item => !excelPartSet.has(item.partNo.trim().toUpperCase()));
        
        const tx = db.transaction('items', 'readwrite'); const st = tx.objectStore('items'); st.clear(); 
        let newIdCounter = 0; let bulkDataToUpload = []; 
        
        for (const key in consolidatedExcel) {
            const data = consolidatedExcel[key]; const isTeknisi = data.locType.toUpperCase().includes('TEKNISI'); let finalLocs = {};
            if (!isTeknisi && locationPool[data.basePartNo]) { finalLocs = { ...locationPool[data.basePartNo] }; delete locationPool[data.basePartNo]; }
            const newItem = { id: idMap[data.compositeKey] || (Date.now() + newIdCounter), locType: data.locType, techName: data.techName, partNo: data.partNo, desc: data.desc, sysQty: data.sysQty, locations: finalLocs, raw: data.raw, lastOpnameDate: '' };
            st.add(newItem); bulkDataToUpload.push(newItem); newIdCounter++;
        }
        
        let rescuedCount = 0;
        localPartsOnly.forEach(item => {
            if (item.locType && item.locType.toUpperCase().includes('TEKNISI')) { item.locations = {}; }
            st.add(item); bulkDataToUpload.push(item); rescuedCount++;
        });
        
        tx.oncomplete = async () => {
            showLoading("📥 Import Stock", "Mengirim ke cloud...");
            updateSyncUI("🚀 Mengirim ke Cloud (Mohon Tunggu)...");
            try {
                await fetch(API_URL, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "bulk_import", data: bulkDataToUpload, logs: [{ partNo: "SEMUA", action: "IMPORT EXCEL", detail: `Import ${bulkDataToUpload.length} Baris Data` }] }) });
                hideLoading();
                alert(`Import & Sync Selesai!\n✅ Data berhasil masuk Google Sheets.\n🛡️ ${rescuedCount} Part Temuan dipertahankan.\n🚫 ${fgSkippedCount} Baris 'FG' dibuang.`);
            } catch (err) { hideLoading(); alert(`Import Lokal Selesai, tapi GAGAL tersambung ke Cloud.`); }
            location.reload(); 
        };
    }; 
    r.readAsArrayBuffer(f);
}

function exportData() {
    showLoading("📤 Export Data", "Mempersiapkan file...");
    
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
                    'Qty Hitung': qty
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
                'Qty Hitung': ''
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
                    'Tanggal Ditemukan': item.lastOpnameDate || '-'
                });
            });
        } else {
            dataBaru.push({
                'Part Number': item.partNo,
                'Lokasi Ditemukan': '',
                'Qty Ditemukan': '',
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
    
    const dataToExport = visibleData.map((item, index) => ({
        "No": visibleData.length - index,
        "Waktu Scan": formatExcelTime(item.time), // <--- BUG 1899 FIXED
        "Kode Box/Colly": item.box,
        "Part Number": item.partNo,
        "QTY Fisik": item.qty,
        "Doc Number (SJOB)": item.docNo,
        "QR Text Raw": item.qr
    }));
    
    const ws = XLSX.utils.json_to_sheet(dataToExport);
    ws['!cols'] = [{wch: 5}, {wch: 22}, {wch: 25}, {wch: 25}, {wch: 10}, {wch: 35}, {wch: 60}];
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
    const newParts = localItems.filter(i => i.desc === 'PART BARU'); if(newParts.length === 0) { alert('Tidak ada.'); return; }
    const ws = XLSX.utils.json_to_sheet(newParts.map(i => ({ 'Part Number': i.partNo, 'Lokasi': Object.keys(i.locations).join(', '), 'Status': 'Perlu Update Nama' })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Part Baru"); XLSX.writeFile(wb, "Daftar_Part_Baru.xlsx");
}

function exportLabelReport() {
    const data = [];
    localItems.forEach(i => { if (i.labelIssues && (i.labelIssues.DAMAGED > 0 || i.labelIssues.NO_LABEL > 0)) data.push({ 'Part Number': i.partNo, 'Deskripsi Part': i.desc, 'Qty Tanpa Label': i.labelIssues.NO_LABEL || 0, 'Qty Label Rusak': i.labelIssues.DAMAGED || 0, 'Terdeteksi di Box': Object.keys(i.locations).join(', ') || 'Belum masuk Box' }); });
    if(data.length === 0) { alert('Tidak ada data!'); return; }
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Laporan Label"); XLSX.writeFile(wb, "Laporan_Label_Bermasalah.xlsx");
}

function backupJson() {
    showLoading("💾 Backup JSON", "Mempersiapkan file...");
    const b = new Blob([JSON.stringify(localItems.map(i => ({ partNo: i.partNo, locations: i.locations })))], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `Mapping_Lokasi_${new Date().toISOString().slice(0,10)}.json`; a.click();
    setTimeout(hideLoading, 500);
}

function restoreJson(input) {
    const f = input.files[0]; if(!f) return;
    if(!confirm("Restore JSON akan menimpa LOKASI FISIK part.\nLanjutkan?")) { input.value = ''; return; }
    showLoading("📂 Restore JSON", `Membaca file: ${f.name}`);
    const r = new FileReader(); 
    r.onload = e => {
        showLoading("📂 Restore JSON", "Memproses data...");
        const backupData = JSON.parse(e.target.result); const tx = db.transaction('items','readwrite'); const st = tx.objectStore('items'); 
        st.getAll().onsuccess = ev => {
            const currentItems = ev.target.result || []; let updateCount = 0;
            backupData.forEach(backupItem => {
                const existingItem = currentItems.find(i => i.partNo === backupItem.partNo);
                if (existingItem) { existingItem.locations = backupItem.locations || {}; st.put(existingItem); updateCount++; }
            });
            tx.oncomplete = () => { hideLoading(); alert(`✅ Restore Selesai!\n${updateCount} part di-update.`); location.reload(); };
        };
    }; r.readAsText(f);
}

// ===== IMPORT OFF BS FILE =====
function handleImportOffBS(input) {
    const f = input.files[0]; 
    if(!f) return;
    
    if(!confirm("Import OFF BS akan mengirim semua data ke sheet Master_Off_BS di Google Sheets (timpa).\n\nLanjutkan?")) {
        input.value = '';
        return;
    }
    
    showLoading("📥 Import OFF BS", `Membaca file: ${f.name}`);
    const r = new FileReader();
    r.onload = async e => {
        updateSyncUI("🔄 Membaca File OFF BS...");
        
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
                alert("❌ Tidak ada data RECEIPT yang ditemukan di file!");
                input.value = '';
                updateSyncUI("🟢 Siap");
                return;
            }
            
            showLoading("📥 Import OFF BS", `Mengirim ${offBsData.length} baris ke cloud...`);
            updateSyncUI(`🚀 Mengirim ${offBsData.length} Data OFF BS ke Cloud...`);
            
            const response = await fetch(API_URL, {
                method: "POST",
                redirect: "follow",
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify({ 
                    action: "import_off_bs", 
                    data: offBsData,
                    timestamp: Date.now()
                })
            });
            
            const result = await response.json();
            
            if (result.status === "success") {
                hideLoading();
                alert(`✅ Import OFF BS Selesai!\n\n📊 Data yang diimpor: ${offBsData.length} baris\n💾 Sheet Master_Off_BS sudah diperbarui di Google Sheets`);
                input.value = '';
                updateSyncUI("🟢 Siap");
            } else {
                hideLoading();
                alert(`❌ Error: ${result.message}`);
                input.value = '';
                updateSyncUI("🔴 Error");
            }
        } catch (err) {
            hideLoading();
            console.error('Import OFF BS Error:', err);
            alert(`❌ Gagal membaca file atau mengirim ke cloud: ${err.message}`);
            input.value = '';
            updateSyncUI("🔴 Error");
        }
    };
    
    r.readAsArrayBuffer(f);
}