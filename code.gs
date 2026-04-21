// Konfigurasi Nama Sheet
const SHEET_DB = "DB_MASTER";
const SHEET_LOG = "LOG_SCAN";

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_DB);
  const data = sheet.getDataRange().getValues();
  const items = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue; 

    let locations = {};
    try { locations = JSON.parse(row[6]) || {}; } catch(err) {}

    let labelIssues = {};
    try { labelIssues = JSON.parse(row[7]) || {}; } catch(err) {}

    items.push({
      id: Number(row[0]),
      partNo: row[1],
      desc: row[2],
      locType: row[3],
      techName: row[4],
      sysQty: Number(row[5]) || 0,
      locations: locations,
      labelIssues: labelIssues
    });
  }

  return ContentService.createTextOutput(JSON.stringify({ status: "success", data: items })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action; 
    const items = payload.data || [];
    const logs = payload.logs || [];

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // =====================================
    // 1. SYNC OFF BS
    // =====================================
    if (action === "sync_off_bs") {
      const sheetTemp = ss.getSheetByName("TEMP_OFF_BS");
      if (!sheetTemp) throw new Error("Sheet TEMP_OFF_BS tidak ditemukan!");

      let insertedCount = 0; let duplicateCount = 0; let duplicateItems = [];
      if (items.length > 0) {
        const existingData = sheetTemp.getDataRange().getValues();
        const existingSet = new Set();
        
        for (let i = 1; i < existingData.length; i++) {
          let partC = existingData[i][2]; let docE = existingData[i][4];
          if (partC && docE) existingSet.add(partC + "_" + docE);
        }

        const rowsToInsert = [];
        items.forEach(item => {
          const uniqueKey = item.partNo + "_" + item.docNo;
          if (existingSet.has(uniqueKey)) {
            duplicateCount++; duplicateItems.push(item.partNo);
          } else {
            // Include updated_at timestamp (column 7)
            rowsToInsert.push([ item.time, item.box, item.partNo, item.qty, item.docNo, item.qr, item.updated_at || Date.now() ]);
            existingSet.add(uniqueKey);
          }
        });

        if (rowsToInsert.length > 0) {
          sheetTemp.getRange(sheetTemp.getLastRow() + 1, 1, rowsToInsert.length, rowsToInsert[0].length).setValues(rowsToInsert);
          insertedCount = rowsToInsert.length;
        }
      }

      let msg = insertedCount + " data OFF BS tersimpan.";
      if (duplicateCount > 0) msg += " (" + duplicateCount + " ditolak karena duplikat)";
      return ContentService.createTextOutput(JSON.stringify({ status: "success", message: msg, inserted: insertedCount, duplicates: duplicateCount, duplicateParts: duplicateItems })).setMimeType(ContentService.MimeType.JSON);
    }

    // =====================================
    // 2. DELETE OFF BS (tidak digunakan - hanya untuk cleanup)
    // =====================================
    else if (action === "delete_off_bs") {
      const sheetTemp = ss.getSheetByName("TEMP_OFF_BS");
      if (!sheetTemp) return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
      
      const rawData = sheetTemp.getDataRange().getValues();
      const itemsToDelete = payload.data || [];
      const signatures = new Set(itemsToDelete.map(item => String(item.qr || "").trim() + "_" + String(item.partNo).trim()));
      
      const dataToKeep = [rawData[0]];
      let deleted = 0;
      
      for (let i = 1; i < rawData.length; i++) {
        const sig = String(rawData[i][5] || "").trim() + "_" + String(rawData[i][2]).trim(); 
        if (signatures.has(sig)) { deleted++; } 
        else { dataToKeep.push(rawData[i]); }
      }
      
      if (deleted > 0) {
        sheetTemp.clearContents();
        sheetTemp.getRange(1, 1, dataToKeep.length, dataToKeep[0].length).setValues(dataToKeep);
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // =====================================
    // 3. GET CLOUD OFF BS (with timestamps)
    // =====================================
    else if (action === "get_cloud_off_bs") {
      const sheetTemp = ss.getSheetByName("TEMP_OFF_BS");
      if (!sheetTemp) throw new Error("Sheet TEMP_OFF_BS tidak ditemukan!");
      const rawData = sheetTemp.getDataRange().getValues();
      if (rawData.length > 0) rawData.shift();
      // Return with updated_at timestamp (col 7 if available, else use current time)
      const formattedData = rawData.map(row => ({ 
        time: row[0], 
        box: row[1], 
        partNo: row[2], 
        qty: row[3], 
        docNo: row[4], 
        qr: row[5] || "",
        updated_at: row[6] || Date.now()
      }));
      return ContentService.createTextOutput(JSON.stringify({ status: "success", data: formattedData })).setMimeType(ContentService.MimeType.JSON);
    }

    // =====================================
    // 4. CHECKOUT / SYNC PACKING
    // =====================================
    else if (action === "sync_packing") {
      const sheetTemp = ss.getSheetByName("TEMP_OFF_BS");
      let sheetPengiriman = ss.getSheetByName("PENGIRIMAN_OFF_BS");
      
      if (!sheetPengiriman) {
        sheetPengiriman = ss.insertSheet("PENGIRIMAN_OFF_BS");
        sheetPengiriman.appendRow(["Waktu Scan Packing", "Colly Pengiriman", "Part Number", "QTY Fisik", "Doc Number (SJOB)", "QR Text Raw", "Updated At"]);
      }
      
      const itemsToPack = payload.data || [];
      if (itemsToPack.length === 0) return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);

      // STEP 1: DEDUPLIKASI incoming items - group by SJOB + partNo, sum qty
      const dedupeMap = {};
      itemsToPack.forEach(item => {
        const key = String(item.docNo).trim() + "|" + String(item.partNo).trim();
        if (!dedupeMap[key]) {
          dedupeMap[key] = {
            time: item.time,
            colly: item.colly,
            partNo: item.partNo,
            qty: 0,
            docNo: item.docNo,
            qr: item.qr,
            updated_at: item.updated_at || Date.now()
          };
        }
        dedupeMap[key].qty += parseInt(item.qty) || 0;
      });
      const deduplicatedItems = Object.values(dedupeMap);

      // STEP 2: Load existing data di PENGIRIMAN_OFF_BS
      const existingData = sheetPengiriman.getDataRange().getValues();
      const existingMap = {};
      for (let i = 1; i < existingData.length; i++) {
        const key = String(existingData[i][4]).trim() + "|" + String(existingData[i][2]).trim(); // docNo | partNo
        if (key !== "|") {
          existingMap[key] = i;
        }
      }

      // STEP 3: Tentukan insert vs update
      const dataToAppend = [];
      const rowsToUpdate = [];
      deduplicatedItems.forEach(item => {
        const key = String(item.docNo).trim() + "|" + String(item.partNo).trim();
        if (existingMap[key]) {
          // Sudah ada → update qty (sum)
          const rowIdx = existingMap[key];
          const existingQty = parseInt(existingData[rowIdx][3]) || 0;
          rowsToUpdate.push({
            rowIdx: rowIdx + 1, // Google Sheets 1-indexed
            newQty: existingQty + item.qty,
            colly: item.colly
          });
        } else {
          // Baru → append
          dataToAppend.push([ item.time, item.colly, item.partNo, item.qty, item.docNo, item.qr, item.updated_at || Date.now() ]);
        }
      });

      // STEP 4: Execute inserts
      if (dataToAppend.length > 0) {
        sheetPengiriman.getRange(sheetPengiriman.getLastRow() + 1, 1, dataToAppend.length, dataToAppend[0].length).setValues(dataToAppend);
      }

      // STEP 5: Execute updates
      if (rowsToUpdate.length > 0) {
        rowsToUpdate.forEach(update => {
          sheetPengiriman.getRange(update.rowIdx, 4).setValue(update.newQty); // Update col QTY
          sheetPengiriman.getRange(update.rowIdx, 2).setValue(update.colly);  // Update col Colly
        });
      }
      
      // STEP 6: Hapus dari TEMP_OFF_BS
      if (sheetTemp) {
        const rawTemp = sheetTemp.getDataRange().getValues();
        if (rawTemp.length > 1) {
          const packSignatures = new Set(itemsToPack.map(item => String(item.qr || "").trim() + "_" + String(item.partNo).trim()));
          const dataToKeep = [rawTemp[0]];
          for (let i = 1; i < rawTemp.length; i++) {
            const sig = String(rawTemp[i][5] || "").trim() + "_" + String(rawTemp[i][2]).trim();
            if (!packSignatures.has(sig)) { dataToKeep.push(rawTemp[i]); }
          }
          sheetTemp.clearContents();
          if (dataToKeep.length > 0) sheetTemp.getRange(1, 1, dataToKeep.length, dataToKeep[0].length).setValues(dataToKeep);
        }
      }
      
      return ContentService.createTextOutput(
        JSON.stringify({ 
          status: "success", 
          deduped: deduplicatedItems.length, 
          inserted: dataToAppend.length, 
          updated: rowsToUpdate.length 
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // =====================================
    // 5. GET CLOUD PACKING (NEW - for two-way sync)
    // =====================================
    else if (action === "get_cloud_packing") {
      let sheetPengiriman = ss.getSheetByName("PENGIRIMAN_OFF_BS");
      if (!sheetPengiriman) {
        return ContentService.createTextOutput(JSON.stringify({ status: "success", data: [] })).setMimeType(ContentService.MimeType.JSON);
      }
      
      const rawData = sheetPengiriman.getDataRange().getValues();
      if (rawData.length > 0) rawData.shift();
      
      const formattedData = rawData.map(row => ({ 
        time: row[0], 
        colly: row[1], 
        partNo: row[2], 
        qty: row[3], 
        docNo: row[4], 
        qr: row[5] || "",
        updated_at: row[6] || Date.now()
      }));
      
      return ContentService.createTextOutput(JSON.stringify({ status: "success", data: formattedData })).setMimeType(ContentService.MimeType.JSON);
    }

    // =====================================
    // 6. IMPORT OFF BS (NEW - Master OFF BS data)
    // =====================================
    else if (action === "import_off_bs") {
      let sheetMasterOffBs = ss.getSheetByName("Master_Off_BS");
      
      // Create sheet if not exists
      if (!sheetMasterOffBs) {
        sheetMasterOffBs = ss.insertSheet("Master_Off_BS", 0); // Insert at beginning
      }
      
      // Define header columns
      const headers = [
        "Nomor", "Kode Perusahaan", "Site", "Departemen", "Nomor Reservasi", 
        "Kode Transaksi", "Tipe Transaksi", "Catatan", "Baris", "Part", 
        "Lot", "Attribute", "Qty Reservasi", "Qty Transaksi", "Qty Close", 
        "UoM", "Serial Number", "Status Reservasi", "Status Pengiriman", 
        "Dibuat Oleh", "Dibuat Pada", "Diubah Oleh", "Diubah Pada", 
        "Ditetapkan Oleh", "Disetujui Pada", "Return To Factory", 
        "Claim To Factory", "Teknisi Perbaikan", "Analisa", "Keterangan", 
        "Import Timestamp"
      ];
      
      // Clear and rebuild sheet
      sheetMasterOffBs.clearContents();
      sheetMasterOffBs.appendRow(headers);
      
      // Insert data rows
      const dataToInsert = items.map(item => [
        item.nomor || "",
        item.kodePerusahaan || "",
        item.site || "",
        item.departemen || "",
        item.nomorReservasi || "",
        item.kodeTranaksi || "",
        item.tipeTranaksi || "",
        item.catatan || "",
        item.baris || "",
        item.part || "",
        item.lot || "",
        item.attribute || "",
        item.qtyReservasi || 0,
        item.qtyTransaksi || 0,
        item.qtyClose || 0,
        item.uom || "",
        item.serialNumber || "",
        item.statusReservasi || "",
        item.statusPengiriman || "",
        item.dibuatOleh || "",
        item.dibuatPada || "",
        item.diubahOleh || "",
        item.diubahPada || "",
        item.ditetapkanOleh || "",
        item.disetujuiPada || "",
        item.returnToFactory || "",
        item.claimToFactory || "",
        item.teknisiPerbaikan || "",
        item.analisa || "",
        item.keterangan || "",
        new Date() // Import timestamp
      ]);
      
      if (dataToInsert.length > 0) {
        sheetMasterOffBs.getRange(2, 1, dataToInsert.length, headers.length).setValues(dataToInsert);
      }
      
      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", 
        message: `${dataToInsert.length} data OFF BS berhasil diimpor ke Master_Off_BS`,
        count: dataToInsert.length
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // =====================================
    // 7. SYNC NORMAL
    // =====================================
    else if (action === "sync" || action === "bulk_import") {
      const dbSheet = ss.getSheetByName(SHEET_DB); 
      const logSheet = ss.getSheetByName(SHEET_LOG); 
      if (logs.length > 0) {
        const logData = logs.map(l => [new Date(), l.partNo, l.action, l.detail]);
        logSheet.getRange(logSheet.getLastRow() + 1, 1, logData.length, 4).setValues(logData);
      }
      if (items.length > 0) mergeDataFast(dbSheet, items); 
      return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Data berhasil disinkronisasi" })).setMimeType(ContentService.MimeType.JSON);
    }

    else { throw new Error("Aksi tidak valid: " + action); }

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function mergeDataFast(sheet, incomingItems) {
  const data = sheet.getDataRange().getValues();
  const idMap = {};
  for (let i = 1; i < data.length; i++) { if (data[i][0]) idMap[data[i][0]] = i; }
  const now = new Date();
  incomingItems.forEach(item => {
    const locString = JSON.stringify(item.locations || {});
    const labelString = JSON.stringify(item.labelIssues || {});
    const rowData = [ item.id, item.partNo, item.desc, item.locType || '', item.techName || '', item.sysQty || 0, locString, labelString, now ];
    if (idMap[item.id]) { data[idMap[item.id]] = rowData; } 
    else { data.push(rowData); idMap[item.id] = data.length - 1; }
  });
  sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
}
