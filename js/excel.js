// js/excel.js

// ==========================================
// 1. IMPORT EXCEL (MEMBACA & MENGGABUNGKAN DATA)
// ==========================================
function handleImport(input) {
    const f = input.files[0]; 
    if(!f) return;
    
    const r = new FileReader();
    r.onload = async e => {
        updateSyncUI("🔄 Membaca Excel...");
        const wb = XLSX.read(e.target.result, {type:'array'});
        const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {defval:''});
        
        const txRead = db.transaction('items', 'readonly');
        const oldItems = await new Promise(resolve => {
            txRead.objectStore('items').getAll().onsuccess = ev => resolve(ev.target.result || []);
        });
        
        const locationPool = {}; 
        const idMap = {}; 
        
        oldItems.forEach(item => {
            const pNo = item.partNo.trim().toUpperCase();
            if (Object.keys(item.locations).length > 0) {
                if (!locationPool[pNo]) locationPool[pNo] = {};
                Object.assign(locationPool[pNo], item.locations); 
            }
            const compositeKey = `${pNo}_${(item.locType||'').toUpperCase()}_${(item.techName||'').toUpperCase()}`;
            idMap[compositeKey] = item.id;
        });
        
        const consolidatedExcel = {};
        let fgSkippedCount = 0; // <--- Variabel Penghitung Baris FG yang dibuang

        json.forEach(row => {
            const rawPartNo = String(row['Part']||row['Nomor Gudang']||'').trim();
            const pNo = rawPartNo.toUpperCase();
            if (!pNo) return; 
            
            const locType = (row['Tipe Lokasi']||'UMUM').trim();

            // =======================================================
            // FITUR BARU: TOLAK BARIS BERAWALAN "FG" (Finished Goods)
            // =======================================================
            if (locType.toUpperCase().startsWith('FG')) {
                fgSkippedCount++; // Tambah hitungan sampah
                return; // Berhenti memproses baris ini, lanjut ke baris berikutnya
            }
            // =======================================================

            const techName = (row['Nama']||'').trim();
            const qty = parseInt(row['Available QTY']||0) || 0;
            const compositeKey = `${pNo}_${locType.toUpperCase()}_${techName.toUpperCase()}`;
            
            if (consolidatedExcel[compositeKey]) {
                consolidatedExcel[compositeKey].sysQty += qty;
            } else {
                consolidatedExcel[compositeKey] = {
                    locType: locType, techName: techName, partNo: rawPartNo,
                    desc: row['Deskripsi Part']||'', sysQty: qty, raw: row,
                    basePartNo: pNo, compositeKey: compositeKey
                };
            }
        });
        
        for (const pNo in locationPool) {
            const hasNonTeknisi = Object.values(consolidatedExcel).some(
                d => d.basePartNo === pNo && !d.locType.toUpperCase().includes('TEKNISI')
            );
            if (!hasNonTeknisi && Object.keys(locationPool[pNo]).length > 0) {
                const dummyKey = `${pNo}_SPAREPART BAIK_`;
                consolidatedExcel[dummyKey] = {
                    locType: 'SPAREPART BAIK', techName: '', partNo: pNo,
                    desc: 'PART MIGRASI (CEK EXCEL)', sysQty: 0, raw: {},
                    basePartNo: pNo, compositeKey: dummyKey
                };
            }
        }
        
        const excelPartSet = new Set(Object.values(consolidatedExcel).map(d => d.basePartNo));
        const localPartsOnly = oldItems.filter(item => !excelPartSet.has(item.partNo.trim().toUpperCase()));
        
        const tx = db.transaction('items', 'readwrite');
        const st = tx.objectStore('items'); 
        st.clear(); 
        
        let newIdCounter = 0;
        let bulkDataToUpload = []; 
        
        for (const key in consolidatedExcel) {
            const data = consolidatedExcel[key];
            const isTeknisi = data.locType.toUpperCase().includes('TEKNISI');
            let finalLocs = {};
            
            if (!isTeknisi && locationPool[data.basePartNo]) {
                finalLocs = { ...locationPool[data.basePartNo] };
                delete locationPool[data.basePartNo]; 
            }
            
            const newItem = {
                id: idMap[data.compositeKey] || (Date.now() + newIdCounter),
                locType: data.locType, techName: data.techName,
                partNo: data.partNo, desc: data.desc, sysQty: data.sysQty,
                locations: finalLocs, raw: data.raw
            };
            
            st.add(newItem);
            bulkDataToUpload.push(newItem); 
            newIdCounter++;
        }
        
        let rescuedCount = 0;
        localPartsOnly.forEach(item => {
            if (item.locType && item.locType.toUpperCase().includes('TEKNISI')) {
                item.locations = {}; 
            }
            st.add(item);
            bulkDataToUpload.push(item); 
            rescuedCount++;
        });
        
        tx.oncomplete = async () => {
            updateSyncUI("🚀 Mengirim ke Cloud (Mohon Tunggu)...");
            try {
                await fetch(API_URL, {
                    method: "POST",
                    redirect: "follow",
                    headers: { "Content-Type": "text/plain;charset=utf-8" },
                    body: JSON.stringify({
                        action: "bulk_import",
                        data: bulkDataToUpload,
                        logs: [{ partNo: "SEMUA", action: "IMPORT EXCEL", detail: `Import ${bulkDataToUpload.length} Baris Data` }]
                    })
                });
                // Alert diupdate agar memunculkan laporan FG yang dibuang
                alert(`Import & Sync Selesai!\n✅ Data berhasil masuk ke Google Sheets.\n🛡️ ${rescuedCount} Part Temuan dipertahankan.\n🚫 ${fgSkippedCount} Baris berawalan 'FG' otomatis dihapus.`);
            } catch (err) {
                console.error(err);
                alert(`Import Lokal Selesai, tapi GAGAL tersambung ke Google Sheets. Pastikan internet menyala!`);
            }
            location.reload(); 
        };
    }; 
    r.readAsArrayBuffer(f);
}

// ==========================================
// 2. EXPORT EXCEL (DOWNLOAD LAPORAN)
// ==========================================
function exportData() {
    // Pisahkan Data Master dan Data Temuan
    const dataUtama = localItems.filter(i => i.desc !== 'PART BARU').map(i => {
        let r = {...i.raw};
        const p = Object.values(i.locations).reduce((a,b) => a+b, 0);
        r['QTY Fisik'] = p; 
        r['Lokasi'] = Object.entries(i.locations).map(([k,v]) => `${k}(${v})`).join(', ');
        r['Tanpa Label (Qty)'] = (i.labelIssues && i.labelIssues.NO_LABEL) ? i.labelIssues.NO_LABEL : 0;
        r['Label Rusak (Qty)'] = (i.labelIssues && i.labelIssues.DAMAGED) ? i.labelIssues.DAMAGED : 0;
        return r;
    });
    
    const dataBaru = localItems.filter(i => i.desc === 'PART BARU').map(i => {
        const p = Object.values(i.locations).reduce((a,b) => a+b, 0);
        return {
            'Part Number': i.partNo, 
            'QTY Fisik': p,
            'Lokasi Ditemukan': Object.entries(i.locations).map(([k,v]) => `${k}(${v})`).join(', ')
        };
    });
    
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dataUtama), "Data Master");
    
    if (dataBaru.length > 0) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dataBaru), "Part Temuan (Baru)");
    }
    XLSX.writeFile(wb, "WMS_Result.xlsx");
}

// js/excel.js (Timpa fungsi ini saja)

function exportOffBsData() {
    if (offBsSession.length === 0) { 
        alert("Belum ada data di sesi ini!"); 
        return; 
    }
    
    // HANYA EXPORT YANG DITAMPILKAN DI LAYAR (TIDAK DI-UNCHECK DI MODAL FILTER)
    // Jika array hiddenOffBsBoxes belum didefinisikan (error), fallback ke array kosong
    const hiddenBoxes = typeof hiddenOffBsBoxes !== 'undefined' ? hiddenOffBsBoxes : [];
    const visibleData = offBsSession.filter(item => !hiddenBoxes.includes(item.box));

    if (visibleData.length === 0) {
        alert("Tidak ada data yang ditampilkan untuk di-export.\nPastikan kamu sudah mencentang Box di tombol Filter!");
        return;
    }
    
    const dataToExport = visibleData.map((item, index) => ({
        "No": visibleData.length - index,
        "Waktu Scan": item.time,
        "Kode Box/Colly": item.box,
        "Part Number": item.partNo,
        "QTY Fisik": item.qty,
        "Doc Number (SJOB)": item.docNo,
        "QR Text Raw": item.qr
    }));
    
    const ws = XLSX.utils.json_to_sheet(dataToExport);
    // Sesuaikan lebar kolom agar rapi
    ws['!cols'] = [{wch: 5}, {wch: 15}, {wch: 25}, {wch: 25}, {wch: 10}, {wch: 35}, {wch: 60}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Temp OFF BS");
    
    // Nama file sekarang menunjukkan jam agar kalau export berkali-kali tidak bentrok
    const timeSuffix = new Date().toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'}).replace(/:/g, '');
    const dateSuffix = new Date().toISOString().slice(0,10).replace(/-/g, '');
    
    XLSX.writeFile(wb, `Packing_OFFBS_${dateSuffix}_${timeSuffix}.xlsx`);
}

function downloadNewParts() {
    const newParts = localItems.filter(i => i.desc === 'PART BARU');
    if(newParts.length === 0) { 
        alert('Tidak ada Part Baru.'); 
        return; 
    }
    const data = newParts.map(i => ({ 
        'Part Number': i.partNo, 
        'Lokasi': Object.keys(i.locations).join(', '), 
        'Status': 'Perlu Update Nama' 
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Part Baru");
    XLSX.writeFile(wb, "Daftar_Part_Baru.xlsx");
}

function exportLabelReport() {
    const data = [];
    localItems.forEach(i => {
        if (i.labelIssues && (i.labelIssues.DAMAGED > 0 || i.labelIssues.NO_LABEL > 0)) {
            data.push({
                'Part Number': i.partNo,
                'Deskripsi Part': i.desc,
                'Qty Tanpa Label': i.labelIssues.NO_LABEL || 0,
                'Qty Label Rusak': i.labelIssues.DAMAGED || 0,
                'Terdeteksi di Box': Object.keys(i.locations).join(', ') || 'Belum masuk Box'
            });
        }
    });
    
    if(data.length === 0) { 
        alert('Tidak ada data label bermasalah untuk di-export!'); 
        return; 
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Laporan Label");
    XLSX.writeFile(wb, "Laporan_Label_Bermasalah.xlsx");
}

// ==========================================
// UPDATE: BACKUP & RESTORE JSON (Hanya Lokasi)
// ==========================================
function backupJson() {
    // Hanya ambil Part Number dan Lokasi fisiknya saja
    const minData = localItems.map(i => ({
        partNo: i.partNo,
        locations: i.locations
    }));
    
    const b = new Blob([JSON.stringify(minData)], {type:'application/json'});
    const a = document.createElement('a'); 
    a.href = URL.createObjectURL(b); 
    // Beri nama yang memperjelas bahwa ini file mapping lokasi
    a.download = `Mapping_Lokasi_${new Date().toISOString().slice(0,10)}.json`; 
    a.click();
}

function restoreJson(input) {
    const f = input.files[0]; 
    if(!f) return;
    
    if(!confirm("Restore JSON akan menimpa LOKASI FISIK part saat ini dengan data dari file.\n(Data QTY Sistem & Deskripsi tidak akan berubah).\nLanjutkan?")) {
        input.value = ''; // Reset input file
        return;
    }
    
    const r = new FileReader(); 
    r.onload = e => {
        const backupData = JSON.parse(e.target.result);
        const tx = db.transaction('items','readwrite'); 
        const st = tx.objectStore('items'); 
        
        st.getAll().onsuccess = ev => {
            const currentItems = ev.target.result || [];
            let updateCount = 0;
            
            // Cocokkan data backup dengan database saat ini
            backupData.forEach(backupItem => {
                const existingItem = currentItems.find(i => i.partNo === backupItem.partNo);
                if (existingItem) {
                    existingItem.locations = backupItem.locations || {}; // Timpa lokasinya
                    st.put(existingItem); // Simpan kembali ke IndexedDB
                    updateCount++;
                }
            });
            
            tx.oncomplete = () => {
                alert(`✅ Restore Selesai!\n${updateCount} part telah diperbarui lokasi fisiknya.`);
                location.reload();
            };
        };
    }; 
    r.readAsText(f);
}
