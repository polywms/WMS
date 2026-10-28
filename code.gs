/*
 * Tujuan: Endpoint Google Apps Script untuk otorisasi Admin, sync lokasi/opname, import SYS_QTY, dan registry box bersama.
 * Caller: js/core.js melalui postWmsAction() untuk registry box dan js/database.js untuk operasi sync.
 * Dependensi: SpreadsheetApp, ContentService, sheet DB_MASTER/LOG_SCAN.
 * Main Functions: doGet()/doPost() expose cloud-owned SYS_QTY, validate X-XY-YY shared BOX_REGISTRY codes, manage rack-grouped registry data, validate box destinations, normalize LOCATIONS/OPNAME_COUNTS, handle stock import, and enforce revision conflicts.
 * Side Effects: Membaca/menulis Google Sheets termasuk BOX_REGISTRY, menggunakan ScriptLock untuk perubahan registry, dan mengirim respons HTTP.
 */

// Konfigurasi Nama Sheet
const SHEET_DB = "DB_MASTER";
const SHEET_LOG = "LOG_SCAN";
const SHEET_ROLE = "WMS_USER_ROLE";
const SHEET_BOX_REGISTRY = "BOX_REGISTRY";
const BOX_REGISTRY_CODE_PATTERN = /^(?:[A-Z]-[A-Z][0-9]-[0-9]{2}|[A-Z0-9]+-[A-Z]-[A-Z][0-9]-[0-9]{2})$/;
const BOX_REGISTRY_PREVIOUS_CODE_PATTERN = /^(?:[A-Z][0-9]{0,2}-[0-9]{2,3}|SPARE-[A-Z][0-9]-[0-9]{2})$/;
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PASSWORD_HASH_ITERATIONS = 12000;
const ADMIN_PASSWORD_MIN_LENGTH = 4;

function normalizeLocationMembershipMap(locations) {
  const normalized = {};
  Object.entries(locations || {}).forEach(([box, value]) => {
    const cleanBox = String(box || "").trim();
    const hasLocation = value === true || (value !== false && value !== null && value !== "" && Number(value) > 0);
    if (cleanBox && hasLocation) normalized[cleanBox] = true;
  });
  return normalized;
}

function normalizeOpnameCountMap(counts, locations) {
  const normalized = {};
  Object.entries(counts || {}).forEach(([box, value]) => {
    const cleanBox = String(box || "").trim();
    const count = Number(value);
    if (!cleanBox || typeof value === "boolean" || !Number.isInteger(count) || count <= 0) return;
    if (!isOpnameLocationTarget(cleanBox, locations)) return;
    normalized[cleanBox] = count;
  });
  return normalized;
}

function normalizeOpnameCompletedMap(completed, locations) {
  const normalized = {};
  Object.entries(completed || {}).forEach(([target, value]) => {
    const cleanTarget = String(target || "").trim().toUpperCase();
    if (value !== true || !cleanTarget || !isOpnameLocationTarget(cleanTarget, locations)) return;
    normalized[cleanTarget] = true;
  });
  return normalized;
}

function isOpnameLocationTarget(target, locations) {
  const normalizedTarget = String(target || "").trim().toUpperCase();
  if (Object.keys(locations || {}).some(location => String(location).trim().toUpperCase() === normalizedTarget)) return true;
  const isRack = /^(?:[A-Z]-[A-Z][0-9]|SPARE-[A-Z][0-9])$/.test(normalizedTarget);
  return isRack && Object.keys(locations || {}).some(location =>
    String(location).trim().toUpperCase().startsWith(normalizedTarget + "-")
  );
}

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    if (e && e.parameter && e.parameter.meta === 'true') {
      const metaSheet = ss.getSheetByName('META');
      const meta = {};
      if (metaSheet) {
        const rows = metaSheet.getDataRange().getValues();
        for (let i = 1; i < rows.length; i++) {
          const k = String(rows[i][0] || '').trim();
          const v = rows[i][1] || '';
          if (k) meta[k] = v;
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ status: 'success', meta: meta })).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (metaErr) {
    // fall through to normal response on error
  }

  const sheet = ss.getSheetByName(SHEET_DB);
  if (!sheet) throw new Error("Sheet DB_MASTER tidak ditemukan!");
  ensureMasterColumnLayout(sheet);

  const data = sheet.getDataRange().getValues();
  const header = data[0] || [];
  const items = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[0]) continue;

    const locationIndex = header.indexOf('LOCATIONS');
    const labelIndex = header.indexOf('LABEL_ISSUES');
    const qtyIndex = header.indexOf('SYS_QTY');
    const updatedIndex = header.indexOf('UPDATED_AT');
    const opnameIndex = header.indexOf('OPNAME_COUNTS');
    const opnameCompletedIndex = header.indexOf('OPNAME_COMPLETED');
    const revisionIndex = header.indexOf('REVISION');

    let locations = {};
    try { locations = JSON.parse(row[locationIndex >= 0 ? locationIndex : 6] || '{}') || {}; } catch (error) {}
    locations = normalizeLocationMembershipMap(locations);

    let labelIssues = {};
    try { labelIssues = JSON.parse(row[labelIndex >= 0 ? labelIndex : 7] || '{}') || {}; } catch (error) {}

    let opnameCounts = {};
    try { opnameCounts = JSON.parse(row[opnameIndex >= 0 ? opnameIndex : 9] || '{}') || {}; } catch (error) {}
    opnameCounts = normalizeOpnameCountMap(opnameCounts, locations);
    let opnameCompleted = {};
    try { opnameCompleted = JSON.parse(row[opnameCompletedIndex >= 0 ? opnameCompletedIndex : 12] || '{}') || {}; } catch (error) {}
    opnameCompleted = normalizeOpnameCompletedMap(opnameCompleted, locations);

    items.push({
      id: Number(row[0]),
      partNo: row[1],
      desc: row[2],
      locType: row[3],
      techName: row[4],
      sysQty: Number(row[qtyIndex >= 0 ? qtyIndex : 5]) || 0,
      locations: locations,
      labelIssues: labelIssues,
      opnameCounts: opnameCounts,
      opnameCompleted: opnameCompleted,
      revision: revisionIndex >= 0 ? (Number(row[revisionIndex]) || 0) : 0,
      updated_at: row[updatedIndex >= 0 ? updatedIndex : 8] instanceof Date
        ? row[updatedIndex >= 0 ? updatedIndex : 8].getTime()
        : (Number(row[updatedIndex >= 0 ? updatedIndex : 8]) || Date.parse(String(row[updatedIndex >= 0 ? updatedIndex : 8] || '')) || 0)
    });
  }

  return ContentService.createTextOutput(JSON.stringify({ status: "success", data: items })).setMimeType(ContentService.MimeType.JSON);
}

function setupAdminPassword() {
  let setupStage = "membuka dialog setup";
  try {
    const ui = SpreadsheetApp.getUi();
    const first = ui.prompt("WMS Admin", "Buat password Admin (minimal 4 karakter). Password tidak disimpan sebagai teks.", ui.ButtonSet.OK_CANCEL);
    if (first.getSelectedButton() !== ui.Button.OK) return;
    const password = first.getResponseText();
    if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
      ui.alert("Password harus memiliki minimal 4 karakter.");
      return;
    }
    const second = ui.prompt("Konfirmasi Password Admin", "Masukkan kembali password Admin.", ui.ButtonSet.OK_CANCEL);
    if (second.getSelectedButton() !== ui.Button.OK) return;
    if (password !== second.getResponseText()) {
      ui.alert("Konfirmasi password tidak cocok. Password belum diubah.");
      return;
    }

    setupStage = "memeriksa spreadsheet dan akun eksekusi";
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) throw new Error("Spreadsheet aktif tidak tersedia.");
    const masterSheet = spreadsheet.getSheetByName(SHEET_DB);
    if (!masterSheet) throw new Error("Sheet DB_MASTER tidak ditemukan.");
    const effectiveUser = Session.getEffectiveUser();
    const email = effectiveUser.getEmail();
    if (!email) throw new Error("Email akun eksekusi tidak tersedia.");

    setupStage = "menyimpan hash password ke sheet role";
    let sheet = spreadsheet.getSheetByName(SHEET_ROLE);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_ROLE);
    const salt = Utilities.getUuid() + Utilities.getUuid();
    const hash = hashAdminPassword(password, salt);
    sheet.clearContents();
    sheet.getRange(1, 1, 2, 4).setValues([
      ["role", "salt", "password_hash", "iterations"],
      ["ADMIN", salt, hash, PASSWORD_HASH_ITERATIONS]
    ]);
    sheet.hideSheet();

    setupStage = "memasang proteksi sheet role";
    const description = "WMS: protect Admin role credential";
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    let protection = protections.find(item => item.getDescription() === description);
    if (!protection) protection = sheet.protect();
    protection.setDescription(description);
    protection.setWarningOnly(false);
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
    const otherEditors = protection.getEditors().filter(editor => editor.getEmail() !== email);
    if (otherEditors.length > 0) protection.removeEditors(otherEditors);
    protection.addEditor(effectiveUser);

    setupStage = "memasang proteksi lokasi DB_MASTER";
    ensureDbMasterLocationProtection(masterSheet);
    ui.alert("Password Admin tersimpan sebagai hash + salt pada sheet terlindungi.");
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    console.error(`setupAdminPassword gagal pada tahap "${setupStage}".`, error);
    throw new Error(`setupAdminPassword gagal pada tahap "${setupStage}": ${detail}`);
  }
}

function hashAdminPassword(password, salt, iterations = PASSWORD_HASH_ITERATIONS) {
  let digest = `${salt}:${password}`;
  for (let i = 0; i < iterations; i++) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      digest,
      Utilities.Charset.UTF_8
    );
    digest = bytes.map(byte => (byte + 256).toString(16).slice(-2)).join("");
  }
  return digest;
}

function constantTimeEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function handleAdminLogin(password) {
  const cache = CacheService.getScriptCache();
  const attempts = Number(cache.get("WMS_ADMIN_LOGIN_FAILURES") || 0);
  if (attempts >= 5) throw new Error("Terlalu banyak percobaan login. Coba lagi setelah 15 menit.");
  if (typeof password !== "string" || password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new Error("Password Admin harus memiliki minimal 4 karakter.");
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ROLE);
  if (!sheet) throw new Error("Password Admin belum disiapkan. Jalankan setupAdminPassword() dari editor Apps Script.");
  const [header, record] = sheet.getRange(1, 1, 2, 4).getValues();
  if (header[0] !== "role" || record[0] !== "ADMIN" || !record[1] || !record[2]) {
    throw new Error("Konfigurasi role Admin tidak valid. Jalankan ulang setupAdminPassword().");
  }
  const iterations = Number(record[3]) || PASSWORD_HASH_ITERATIONS;
  const expected = String(record[2]);
  const actual = hashAdminPassword(password, String(record[1]), iterations);
  if (!constantTimeEquals(actual, expected)) {
    cache.put("WMS_ADMIN_LOGIN_FAILURES", String(attempts + 1), 900);
    throw new Error("Password Admin salah.");
  }

  cache.remove("WMS_ADMIN_LOGIN_FAILURES");
  const token = Utilities.getUuid() + Utilities.getUuid();
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  const properties = PropertiesService.getScriptProperties();
  const tokenKey = `WMS_ADMIN_SESSION_${Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token))}`;
  properties.setProperty(tokenKey, String(expiresAt));
  return ContentService.createTextOutput(JSON.stringify({
    status: "success",
    sessionToken: token,
    expiresAt: expiresAt
  })).setMimeType(ContentService.MimeType.JSON);
}

function validateAdminSession(token) {
  if (typeof token !== "string" || !token) return false;
  const tokenKey = `WMS_ADMIN_SESSION_${Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token))}`;
  const properties = PropertiesService.getScriptProperties();
  const expiresAt = Number(properties.getProperty(tokenKey) || 0);
  if (expiresAt <= Date.now()) {
    if (expiresAt) properties.deleteProperty(tokenKey);
    return false;
  }
  return true;
}

function revokeAdminSession(token) {
  if (!validateAdminSession(token)) throw new Error("Sesi Admin tidak valid atau sudah kedaluwarsa.");
  const tokenKey = `WMS_ADMIN_SESSION_${Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token))}`;
  PropertiesService.getScriptProperties().deleteProperty(tokenKey);
}

function ensureDbMasterLocationProtection(sheet) {
  const description = "WMS: DB_MASTER physical locations managed by app";
  const locationRange = sheet.getRange("G:G");
  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  let protection = protections.find(item => item.getDescription() === description);

  if (!protection) protection = locationRange.protect();
  protection.setDescription(description);
  if (protection.getRange().getA1Notation() !== locationRange.getA1Notation()) {
    protection.setRange(locationRange);
  }
  protection.setWarningOnly(false);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);

  const effectiveUser = Session.getEffectiveUser();
  const effectiveEmail = effectiveUser.getEmail();
  if (!effectiveEmail) {
    throw new Error("Tidak dapat mengunci kolom lokasi DB_MASTER: email akun eksekusi tidak tersedia.");
  }

  const otherEditors = protection.getEditors()
    .filter(editor => editor.getEmail() !== effectiveEmail);
  if (otherEditors.length > 0) protection.removeEditors(otherEditors);
  protection.addEditor(effectiveUser);
}

function normalizeBoxRegistryCode(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .trim()
    .toUpperCase();
  return BOX_REGISTRY_CODE_PATTERN.test(normalized) ? normalized : null;
}

function normalizeStoredBoxRegistryCode(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .trim()
    .toUpperCase();
  return BOX_REGISTRY_CODE_PATTERN.test(normalized) || BOX_REGISTRY_PREVIOUS_CODE_PATTERN.test(normalized)
    ? normalized
    : null;
}

function getBoxRegistrySheet(spreadsheet, createIfMissing) {
  let sheet = spreadsheet.getSheetByName(SHEET_BOX_REGISTRY);
  if (!sheet && createIfMissing) sheet = spreadsheet.insertSheet(SHEET_BOX_REGISTRY);
  if (!sheet) return null;
  if (sheet.getLastRow() === 0) {
    if (!createIfMissing) return sheet;
    sheet.getRange(1, 1).setValue("BOX_CODE");
  } else if (String(sheet.getRange(1, 1).getValue()).trim() !== "BOX_CODE") {
    throw new Error("Header sheet BOX_REGISTRY tidak valid; kolom pertama harus BOX_CODE.");
  }
  return sheet;
}

function readBoxRegistryCodes(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const codes = new Set();
  values.forEach((row, index) => {
    if (row[0] === "" || row[0] === null) return;
    const code = normalizeStoredBoxRegistryCode(row[0]);
    if (!code) throw new Error("Kode box tidak valid di BOX_REGISTRY baris " + (index + 2) + ".");
    codes.add(code);
  });
  return [...codes].sort();
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action; 
    const items = payload.data || [];
    const logs = payload.logs || [];

    if (action === "admin_login") return handleAdminLogin(payload.password);
    const readOnlyActions = ["get_cloud_off_bs", "get_cloud_packing"];
    if (!readOnlyActions.includes(action) && !validateAdminSession(payload.authToken)) {
      throw new Error("Aksi ditolak: sesi Admin tidak valid atau sudah kedaluwarsa.");
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (action === "admin_logout") {
      revokeAdminSession(payload.authToken);
      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "get_box_registry") {
      const sheet = getBoxRegistrySheet(ss, false);
      const data = sheet ? readBoxRegistryCodes(sheet) : [];
      return ContentService.createTextOutput(JSON.stringify({ status: "success", data: data })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "save_box_registry") {
      if (!Array.isArray(items) || items.length > 500) throw new Error("Daftar box harus berupa array dengan maksimal 500 kode per simpan.");
      const incomingCodes = items.map(normalizeBoxRegistryCode);
      if (incomingCodes.some(code => !code)) throw new Error("Ada kode box yang tidak valid dalam daftar.");

      const writeLock = LockService.getScriptLock();
      if (!writeLock.tryLock(30000)) throw new Error("Daftar box sedang diperbarui. Coba lagi sebentar.");
      try {
        const sheet = getBoxRegistrySheet(ss, true);
        const existingCodes = new Set(readBoxRegistryCodes(sheet));
        const codesToAdd = [...new Set(incomingCodes)].filter(code => !existingCodes.has(code));
        if (codesToAdd.length > 0) {
          sheet.getRange(sheet.getLastRow() + 1, 1, codesToAdd.length, 1).setValues(codesToAdd.map(code => [code]));
        }
        return ContentService.createTextOutput(JSON.stringify({
          status: "success",
          added: codesToAdd.length,
          data: readBoxRegistryCodes(sheet)
        })).setMimeType(ContentService.MimeType.JSON);
      } finally {
        writeLock.releaseLock();
      }
    }

    if (action === "delete_box_registry") {
      const boxCode = normalizeStoredBoxRegistryCode(payload.boxCode);
      if (!boxCode) throw new Error("Kode box untuk dihapus tidak valid.");

      const writeLock = LockService.getScriptLock();
      if (!writeLock.tryLock(30000)) throw new Error("Daftar box sedang diperbarui. Coba lagi sebentar.");
      try {
        const sheet = getBoxRegistrySheet(ss, false);
        let deleted = 0;
        if (sheet && sheet.getLastRow() > 1) {
          const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
          for (let index = values.length - 1; index >= 0; index--) {
            if (normalizeBoxRegistryCode(values[index][0]) === boxCode) {
              sheet.deleteRow(index + 2);
              deleted++;
            }
          }
        }
        const data = sheet ? readBoxRegistryCodes(sheet) : [];
        return ContentService.createTextOutput(JSON.stringify({
          status: "success",
          deleted: deleted,
          data: data
        })).setMimeType(ContentService.MimeType.JSON);
      } finally {
        writeLock.releaseLock();
      }
    }

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
      if (!dbSheet) throw new Error("Sheet DB_MASTER tidak ditemukan!");
      const writeLock = LockService.getScriptLock();
      if (!writeLock.tryLock(30000)) throw new Error("Data sedang diperbarui. Coba lagi sebentar.");
      let idMappings = [];
      let revisionMappings = [];
      try {
        ensureDbMasterLocationProtection(dbSheet);
        const revisionColumnIndex = ensureMasterRevisionColumn(dbSheet);
        clearDuplicateMasterRows(dbSheet, revisionColumnIndex);
        if (action === "sync" && items.length > 0) {
          const conflicts = getMasterRevisionConflicts(dbSheet, items, revisionColumnIndex);
          if (conflicts.length > 0) {
            return ContentService.createTextOutput(JSON.stringify({
              status: "conflict",
              message: "Data cloud berubah sejak salinan lokal dibuat.",
              conflicts: conflicts
            })).setMimeType(ContentService.MimeType.JSON);
          }
        }
        if (logs.length > 0) {
          const logData = logs.map(l => [new Date(), l.partNo, l.action, l.detail]);
          logSheet.getRange(logSheet.getLastRow() + 1, 1, logData.length, 4).setValues(logData);
        }
        if (items.length > 0) {
          if (action === "bulk_import") {
            idMappings = mergeStockQuantities(dbSheet, items, revisionColumnIndex);
          } else {
            validateLocationDestinations(dbSheet, items);
            revisionMappings = mergeDataFast(dbSheet, items, revisionColumnIndex);
          }
        }

        // Update META sheet with lastStockUploadAt so clients can read shared timestamp.
        if (action === "bulk_import") {
          try {
            let metaSheet = ss.getSheetByName('META');
            if (!metaSheet) metaSheet = ss.insertSheet('META');
            const header = metaSheet.getRange(1, 1, 1, 2).getValues()[0];
            if (header[0] !== 'key' || header[1] !== 'value') {
              metaSheet.clearContents();
              metaSheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
            }
            const key = 'lastStockUploadAt';
            const value = new Date().toISOString();
            const metaData = metaSheet.getDataRange().getValues();
            let foundRow = -1;
            for (let i = 1; i < metaData.length; i++) {
              if (String(metaData[i][0]) === key) { foundRow = i + 1; break; }
            }
            if (foundRow !== -1) {
              metaSheet.getRange(foundRow, 2).setValue(value);
            } else {
              metaSheet.getRange(metaSheet.getLastRow() + 1, 1, 1, 2).setValues([[key, value]]);
            }
          } catch (metaErr) {
            try {
              logSheet.getRange(logSheet.getLastRow() + 1, 1, 1, 4)
                .setValues([[new Date(), 'META', 'WRITE_ERROR', String(metaErr)]]);
            } catch (logError) {
              console.error('Failed to log META write error:', logError);
            }
          }
        }
      } finally {
        writeLock.releaseLock();
      }

      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Data berhasil disinkronisasi",
        idMappings: action === "bulk_import" ? idMappings : undefined,
        revisions: action === "sync" ? revisionMappings : undefined
      })).setMimeType(ContentService.MimeType.JSON);
    }

    else { throw new Error("Aksi tidak valid: " + action); }

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function ensureMasterColumnLayout(sheet) {
  const headers = [
    'ID', 'PART_NO', 'DESC', 'LOC_TYPE', 'TECH_NAME', 'SYS_QTY',
    'LOCATIONS', 'LABEL_ISSUES', 'UPDATED_AT', 'OPNAME_COUNTS', 'HARGA', 'REVISION', 'OPNAME_COMPLETED'
  ];
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }

  const existing = data[0] || [];
  headers.forEach((headerName, index) => {
    if (existing[index] !== headerName) {
      if (typeof existing[index] === 'undefined' || existing[index] === '') {
        sheet.getRange(1, index + 1).setValue(headerName);
      } else {
        sheet.getRange(1, index + 1).setValue(headerName);
      }
    }
  });

  return;
}

function ensureMasterRevisionColumn(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) throw new Error("DB_MASTER belum memiliki header.");
  ensureMasterColumnLayout(sheet);
  const dataAfterLayout = sheet.getDataRange().getValues();
  let index = dataAfterLayout[0].indexOf("REVISION");
  if (index < 0) {
    index = dataAfterLayout[0].length;
    sheet.getRange(1, index + 1).setValue("REVISION");
  }
  return index;
}

function masterRowToItem(row, revisionColumnIndex) {
  let locations = {};
  let labelIssues = {};
  let opnameCounts = {};
  let opnameCompleted = {};
  try { locations = JSON.parse(row[6]) || {}; } catch (error) {}
  try { labelIssues = JSON.parse(row[7]) || {}; } catch (error) {}
  try { opnameCounts = JSON.parse(row[9]) || {}; } catch (error) {}
  try { opnameCompleted = JSON.parse(row[12]) || {}; } catch (error) {}
  locations = normalizeLocationMembershipMap(locations);
  opnameCounts = normalizeOpnameCountMap(opnameCounts, locations);
  opnameCompleted = normalizeOpnameCompletedMap(opnameCompleted, locations);
  return {
    id: Number(row[0]),
    partNo: row[1],
    desc: row[2],
    locType: row[3],
    techName: row[4],
    sysQty: Number(row[5]) || 0,
    locations: locations,
    labelIssues: labelIssues,
    opnameCounts: opnameCounts,
    opnameCompleted: opnameCompleted,
    revision: Number(row[revisionColumnIndex]) || 0,
    updated_at: row[8] instanceof Date ? row[8].getTime() : (Number(row[8]) || Date.parse(row[8]) || 0)
  };
}

function getMasterRevisionConflicts(sheet, incomingItems, revisionColumnIndex) {
  const data = sheet.getDataRange().getValues();
  const byId = new Map();
  const byKey = new Map();
  for (let index = 1; index < data.length; index++) {
    const row = data[index];
    byId.set(String(row[0]), row);
    byKey.set(getMasterItemKey(row[1], row[3], row[4]), row);
  }
  const conflicts = [];
  incomingItems.forEach(item => {
    const key = getMasterItemKey(item.partNo, item.locType, item.techName);
    const idRow = byId.get(String(item.id));
    const row = idRow && getMasterItemKey(idRow[1], idRow[3], idRow[4]) === key
      ? idRow
      : byKey.get(key);
    if (!row) return;
    const revision = Number(row[revisionColumnIndex]) || 0;
    if (Number(item.revision) !== revision) {
      conflicts.push({
        clientId: item.id,
        id: Number(row[0]),
        expectedRevision: Number(item.revision),
        revision: revision,
        cloudItem: masterRowToItem(row, revisionColumnIndex)
      });
    }
  });
  return conflicts;
}

function getMasterItemKey(partNo, locType, techName) {
  const normalizedType = String(locType || "").trim().toUpperCase();
  const normalizedTech = normalizedType === "SPAREPART BAIK"
    ? ""
    : String(techName || "").trim().toUpperCase();
  return `${String(partNo || "").trim().toUpperCase()}|${normalizedType}|${normalizedTech}`;
}

function validateLocationDestinations(sheet, incomingItems) {
  if (!Array.isArray(incomingItems)) throw new Error("Data sinkronisasi harus berupa array.");
  const rows = sheet.getDataRange().getValues();
  const byId = new Map();
  const byKey = new Map();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] !== "" && rows[i][0] !== null) byId.set(String(rows[i][0]), rows[i]);
    byKey.set(getMasterItemKey(rows[i][1], rows[i][3], rows[i][4]), rows[i]);
  }
  incomingItems.forEach(item => {
    const key = getMasterItemKey(item.partNo, item.locType, item.techName);
    const idRow = byId.get(String(item.id));
    const existing = idRow && getMasterItemKey(idRow[1], idRow[3], idRow[4]) === key
      ? idRow
      : byKey.get(key);
    const existingLocations = existing ? (JSON.parse(existing[6] || "{}")) : {};
    const existingKeys = new Set(Object.keys(existingLocations).map(box => String(box).trim().toUpperCase()));
    const validBoxPattern = /^(?:[A-Z]-[A-Z][0-9]-[0-9]{2}|SPARE-[A-Z][0-9]-[0-9]{2}|[A-Z0-9]+-[A-Z]-[A-Z][0-9]-[0-9]{2})$/;
    const validRackPattern = /^(?:[A-Z]-[A-Z][0-9]|SPARE-[A-Z][0-9])$/;
    const invalidDestination = Object.keys(item.locations || {}).find(box => {
      const normalized = String(box).trim().toUpperCase();
      return !existingKeys.has(normalized) && !validBoxPattern.test(normalized) && !validRackPattern.test(normalized);
    });
    if (invalidDestination) {
      throw new Error(`Lokasi tujuan ${invalidDestination} tidak valid atau merupakan format legacy.`);
    }
  });
}

function clearDuplicateMasterRows(sheet, revisionColumnIndex) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) return;

  const header = rows[0];
  const latestByKey = new Map();
  const rowCount = rows.length;

  for (let i = 1; i < rowCount; i++) {
    const row = rows[i];
    if (!row || row.every(value => value === "" || value === null || value === undefined)) continue;
    const partNo = String(row[1] || "").trim();
    if (!partNo) continue;
    const key = getMasterItemKey(partNo, row[3], row[4]);
    const rowUpdatedAt = row[8] instanceof Date ? row[8].getTime() : Number(row[8]) || Date.parse(String(row[8] || "")) || 0;
    const rowRevision = Number(row[revisionColumnIndex]) || 0;
    const current = latestByKey.get(key);
    if (!current || rowUpdatedAt > current.updatedAt || (rowUpdatedAt === current.updatedAt && rowRevision > current.revision) || (rowUpdatedAt === current.updatedAt && rowRevision === current.revision && i > current.index)) {
      latestByKey.set(key, { index: i, updatedAt: rowUpdatedAt, revision: rowRevision, row: row });
    }
  }

  const keepIndexes = new Set(Array.from(latestByKey.values()).map(entry => entry.index));
  const finalRows = [header];
  for (let i = 1; i < rowCount; i++) {
    if (keepIndexes.has(i)) finalRows.push(rows[i]);
  }

  const width = Math.max(...finalRows.map(row => row.length));
  const normalized = finalRows.map(row => {
    const copy = [...row];
    while (copy.length < width) copy.push("");
    return copy;
  });

  sheet.clearContents();
  if (normalized.length > 0) {
    sheet.getRange(1, 1, normalized.length, width).setValues(normalized);
  }
}

function mergeStockQuantities(sheet, incomingItems, revisionColumnIndex) {
  if (!Array.isArray(incomingItems)) throw new Error("Data import stock harus berupa array.");
  incomingItems.forEach(item => {
    if (!item || typeof item !== "object" || !String(item.partNo || "").trim()) {
      throw new Error("Setiap baris import wajib memiliki Part Number.");
    }
    const quantity = Number(item.sysQty);
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) {
      throw new Error(`Qty import tidak valid untuk part ${item.partNo}.`);
    }
  });
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) throw new Error("DB_MASTER belum memiliki header.");
  if (!data[0][9]) sheet.getRange(1, 10).setValue("OPNAME_COUNTS");

  const rowIndexesByKey = new Map();
  const idMap = new Map();
  let nextId = 0;
  for (let i = 1; i < data.length; i++) {
    const key = getMasterItemKey(data[i][1], data[i][3], data[i][4]);
    if (!rowIndexesByKey.has(key)) rowIndexesByKey.set(key, []);
    rowIndexesByKey.get(key).push(i);
    if (data[i][0] !== "" && data[i][0] !== null) idMap.set(String(data[i][0]), i);
    nextId = Math.max(nextId, Number(data[i][0]) || 0);
  }

  const now = new Date();
  const quantityUpdates = new Map();
  const revisionUpdates = new Map();
  const newRows = [];
  const idMappings = [];
  incomingItems.forEach(item => {
    const key = getMasterItemKey(item.partNo, item.locType, item.techName);
    if (!key.startsWith("|")) {
      const candidates = rowIndexesByKey.get(key) || [];
      const matchingId = candidates.find(index => String(
        index < data.length ? data[index][0] : newRows[index - data.length][0]
      ) === String(item.id));
      const existingIndex = matchingId === undefined ? candidates[0] : matchingId;
      if (existingIndex !== undefined) {
        if (existingIndex < data.length) {
          quantityUpdates.set(existingIndex + 1, Number(item.sysQty) || 0);
          const revision = (Number(data[existingIndex][revisionColumnIndex]) || 0) + 1;
          revisionUpdates.set(existingIndex + 1, revision);
          idMappings.push({ clientId: item.id, id: data[existingIndex][0], key, revision, updated_at: now.getTime() });
        } else {
          const newRow = newRows[existingIndex - data.length];
          newRow[5] = Number(item.sysQty) || 0;
          newRow[revisionColumnIndex] = (Number(newRow[revisionColumnIndex]) || 0) + 1;
          idMappings.push({ clientId: item.id, id: newRow[0], key, revision: newRow[revisionColumnIndex], updated_at: now.getTime() });
        }
        return;
      }
    }

    let id = item.id;
    if (idMap.has(String(id))) {
      nextId += 1;
      id = nextId;
    }
    const row = [
      id, item.partNo, item.desc || "", item.locType || "", item.techName || "",
      Number(item.sysQty) || 0, "{}", "{}", now, "{}"
    ];
    while (row.length <= revisionColumnIndex) row.push("");
    row[revisionColumnIndex] = 1;
    newRows.push(row);
    idMappings.push({ clientId: item.id, id, key, revision: 1, updated_at: now.getTime() });
    idMap.set(String(id), data.length + newRows.length - 1);
    if (!rowIndexesByKey.has(key)) rowIndexesByKey.set(key, []);
    rowIndexesByKey.get(key).push(data.length + newRows.length - 1);
  });

  const sortedUpdates = Array.from(quantityUpdates.entries()).sort((a, b) => a[0] - b[0]);
  for (let index = 0; index < sortedUpdates.length;) {
    const startRow = sortedUpdates[index][0];
    const values = [[sortedUpdates[index][1]]];
    index++;
    while (index < sortedUpdates.length && sortedUpdates[index][0] === startRow + values.length) {
      values.push([sortedUpdates[index][1]]);
      index++;
    }
    sheet.getRange(startRow, 6, values.length, 1).setValues(values);
    sheet.getRange(startRow, 9, values.length, 1).setValues(values.map(() => [now]));
  }

  const sortedRevisionUpdates = Array.from(revisionUpdates.entries()).sort((a, b) => a[0] - b[0]);
  for (let index = 0; index < sortedRevisionUpdates.length;) {
    const startRow = sortedRevisionUpdates[index][0];
    const values = [[sortedRevisionUpdates[index][1]]];
    index++;
    while (index < sortedRevisionUpdates.length && sortedRevisionUpdates[index][0] === startRow + values.length) {
      values.push([sortedRevisionUpdates[index][1]]);
      index++;
    }
    sheet.getRange(startRow, revisionColumnIndex + 1, values.length, 1).setValues(values);
  }

  if (newRows.length > 0) {
    const columnCount = Math.max(data[0].length, revisionColumnIndex + 1);
    newRows.forEach(row => { while (row.length < columnCount) row.push(""); });
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, columnCount).setValues(newRows);
  }
  return idMappings;
}

function mergeDataFast(sheet, incomingItems, revisionColumnIndex) {
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) data.push([]);
  const columnCount = Math.max(data[0].length, 13, revisionColumnIndex + 1);
  while (data[0].length < columnCount) data[0].push("");
  if (!data[0][9]) data[0][9] = "OPNAME_COUNTS";
  if (!data[0][12]) data[0][12] = "OPNAME_COMPLETED";
  data[0][revisionColumnIndex] = "REVISION";
  for (let i = 1; i < data.length; i++) {
    while (data[i].length < columnCount) data[i].push("");
  }
  const idMap = {};
  const keyMap = {};
  for (let i = 1; i < data.length; i++) { if (data[i][0]) idMap[data[i][0]] = i; }
  for (let i = 1; i < data.length; i++) {
    keyMap[getMasterItemKey(data[i][1], data[i][3], data[i][4])] = i;
  }
  const now = new Date();
  const revisionMappings = [];
  const locationUpdates = new Map();
  const opnameUpdates = new Map();
  const opnameCompletedUpdates = new Map();
  const timestampUpdates = new Map();
  const revisionUpdates = new Map();
  const newRows = [];
  incomingItems.forEach(item => {
    const key = getMasterItemKey(item.partNo, item.locType, item.techName);
    const rowIndex = idMap[item.id] !== undefined
      ? idMap[item.id]
      : keyMap[key];
    const existingRow = rowIndex !== undefined ? data[rowIndex] : null;
    if (existingRow && getMasterItemKey(existingRow[1], existingRow[3], existingRow[4]) !== key) {
      throw new Error(`ID ${item.id} sudah dipakai part lain; sinkronisasi dibatalkan untuk mencegah data tertukar.`);
    }
    const hasLocations = Object.prototype.hasOwnProperty.call(item, "locations");
    const hasOpnameCounts = Object.prototype.hasOwnProperty.call(item, "opnameCounts");
    const hasOpnameCompleted = Object.prototype.hasOwnProperty.call(item, "opnameCompleted");
    if (hasLocations && (!item.locations || typeof item.locations !== "object" || Array.isArray(item.locations))) {
      throw new Error(`LOCATIONS tidak valid untuk part ${item.partNo}.`);
    }
    if (hasOpnameCounts && (!item.opnameCounts || typeof item.opnameCounts !== "object" || Array.isArray(item.opnameCounts))) {
      throw new Error(`OPNAME_COUNTS tidak valid untuk part ${item.partNo}.`);
    }
    if (hasOpnameCompleted && (!item.opnameCompleted || typeof item.opnameCompleted !== "object" || Array.isArray(item.opnameCompleted))) {
      throw new Error(`OPNAME_COMPLETED tidak valid untuk part ${item.partNo}.`);
    }
    let existingLocations = {};
    let existingOpnameCounts = {};
    let existingOpnameCompleted = {};
    try { existingLocations = JSON.parse(existingRow ? existingRow[6] || '{}' : '{}') || {}; } catch (error) {}
    try { existingOpnameCounts = JSON.parse(existingRow ? existingRow[9] || '{}' : '{}') || {}; } catch (error) {}
    try { existingOpnameCompleted = JSON.parse(existingRow ? existingRow[12] || '{}' : '{}') || {}; } catch (error) {}
    const normalizedLocations = normalizeLocationMembershipMap(hasLocations ? item.locations : existingLocations);
    const normalizedOpnameCounts = normalizeOpnameCountMap(
      hasOpnameCounts ? item.opnameCounts : existingOpnameCounts,
      normalizedLocations
    );
    const normalizedOpnameCompleted = normalizeOpnameCompletedMap(
      hasOpnameCompleted ? item.opnameCompleted : existingOpnameCompleted,
      normalizedLocations
    );
    const keptLocations = JSON.stringify(normalizedLocations);
    const keptLabelIssues = existingRow ? existingRow[7] || '{}' : '{}';
    const keptOpnameCounts = JSON.stringify(normalizedOpnameCounts);
    const keptOpnameCompleted = JSON.stringify(normalizedOpnameCompleted);
    const rowData = [
      existingRow ? existingRow[0] : item.id,
      item.partNo,
      existingRow ? existingRow[2] : '',
      existingRow ? existingRow[3] : (item.locType || ''),
      existingRow ? existingRow[4] : (item.techName || ''),
      existingRow ? (Number(existingRow[5]) || 0) : 0,
      keptLocations,
      keptLabelIssues,
      now,
      keptOpnameCounts
    ];
    if (columnCount > 10) {
      rowData.push(...(existingRow ? existingRow.slice(10, columnCount) : Array(columnCount - 10).fill("")));
    }
    const revision = (existingRow ? Number(existingRow[revisionColumnIndex]) || 0 : 0) + 1;
    rowData[revisionColumnIndex] = revision;
    rowData[12] = keptOpnameCompleted;
    if (existingRow) {
      const sheetRow = rowIndex + 1;
      locationUpdates.set(sheetRow, keptLocations);
      opnameUpdates.set(sheetRow, keptOpnameCounts);
      opnameCompletedUpdates.set(sheetRow, keptOpnameCompleted);
      timestampUpdates.set(sheetRow, now);
      revisionUpdates.set(sheetRow, revision);
      revisionMappings.push({ clientId: item.id, id: existingRow[0], revision, updated_at: now.getTime() });
      return;
    }
    newRows.push(rowData);
    const newRowIndex = data.length + newRows.length - 1;
    idMap[item.id] = newRowIndex;
    keyMap[key] = newRowIndex;
    revisionMappings.push({ clientId: item.id, id: rowData[0], revision, updated_at: now.getTime() });
  });

  const writeColumnUpdates = (columnIndex, updates) => {
    const entries = Array.from(updates.entries()).sort((a, b) => a[0] - b[0]);
    for (let index = 0; index < entries.length;) {
      const startRow = entries[index][0];
      const values = [[entries[index][1]]];
      index++;
      while (index < entries.length && entries[index][0] === startRow + values.length) {
        values.push([entries[index][1]]);
        index++;
      }
      sheet.getRange(startRow, columnIndex, values.length, 1).setValues(values);
    }
  };

  writeColumnUpdates(7, locationUpdates);
  writeColumnUpdates(10, opnameUpdates);
  writeColumnUpdates(13, opnameCompletedUpdates);
  writeColumnUpdates(9, timestampUpdates);
  writeColumnUpdates(revisionColumnIndex + 1, revisionUpdates);
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, columnCount).setValues(newRows);
  }
  return revisionMappings;
}
