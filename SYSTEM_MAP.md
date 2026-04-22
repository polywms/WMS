# SYSTEM MAP - WMS Magelang V6

**Panduan Navigasi**: 
- **Untuk Memahami Alur Sistem**: Lihat section "Core Logic Flow"
- **Untuk Menemukan Fungsi**: Lihat "Module Map" dan "Module Dependencies Graph"
- **Untuk Integrasi Eksternal**: Lihat "External Integrations" dan "Data & Config"
- **Untuk Troubleshooting**: Lihat "Risks / Blind Spots"
- **Untuk Perubahan Terbaru**: Lihat "Latest Improvements" di Risks section

---

## Project Summary

**Tujuan Aplikasi**  
Sistem Manajemen Gudang berbasis web untuk pencatatan stok real-time, inventory checking (opname), pencatatan off-balance-sheet, dan manajemen packing. Dirancang untuk pemindaian barcode dan QR dengan dukungan offline-first menggunakan PWA.

**Tech Stack Utama**
- **Runtime**: HTML5 + Vanilla JavaScript (ES6+)
- **Storage**: IndexedDB (local cache), localStorage (session data)
- **API Backend**: Google Sheets (via Google Apps Script macro)
- **Offline Support**: Service Worker (Cache-Network-First strategy)
- **Scanner**: Html5QrcodeScanner library
- **Excel Import/Export**: SheetJS (XLSX.js)
- **Audio**: Web Audio API (feedback tone)
- **Device**: Web vibration API + Screen Wake Lock

**Pola Arsitektur**  
Arsitektur layering sederhana: View (HTML/Tab) → Controller (core.js processScan) → Service (CRUD functions) → Repository (saveDB/loadDataFromLocal) → Storage (IndexedDB + localStorage) → Cloud (Google Sheets via API).

---

## Core Logic Flow (Function-Level Flowchart)

### Flow 1: Pemindaian Normal (SIMPAN Tab)
```
User Scan Code
  ↓
handleInputKeyDown() [core.js]
  ↓
processScan(code) [core.js] — Parse & route per tab
  ↓
filteredItems.find() — Match part in localItems
  ↓
selectPartSimpan(item) [core.js] — Select active part
  ↓
User Scan Box / Input Location
  ↓
checkSimpanConflict() [core.js] — Validate move/split
  ↓
executeSimpanAction() [core.js] — Update item.locations
  ↓
saveDB(item) [database.js] — Write to IndexedDB + queue sync
  ↓
renderSimpanList() [core.js] — Update UI
  ↓
processSyncQueue() [database.js] — (Async) POST to Google Sheets
```

### Flow 2: Opname (Inventory Check)
```
Filter by box → handleOpnameRender() [core.js]
  ↓
Display items grouped by part
  ↓
User Scan Part + Box Location
  ↓
promptOpnameConflict() [core.js] — Check existing locations
  ↓
executeOpnameAction() — Move or Add location
  ↓
saveDB() → sync queue
  ↓
Reload opname view
```

### Flow 3: Off BS (Off-Balance-Sheet)
```
User Scan "RTF" box code
  ↓
activeOffBsBox = code
  ↓
User Scan Part QR
  ↓
Validate: part exists in OFF BS location
  ↓
Check: qty <= masterItem.sysQty
  ↓
Check: QR not duplicate scanned
  ↓
offBsSession.unshift() → localStorage
  ↓
triggerOffBsSync() [database.js] → POST to Cloud
```

### Flow 4: Multi-Scan (Buffer Mode)
```
toggleMultiMode() → isMultiScan = true
  ↓
multiBuffer[] = []
  ↓
Scan Part 1, 2, 3, ... → addToMultiBuffer()
  ↓
Scan Box → processMultiBatchMove(box, actionType)
  ↓
For each item in buffer: item.locations[box] = 1
  ↓
saveDB() per item + sync queue
  ↓
clearMultiBuffer()
```

### Flow 5: Packing (Colly Management)
```
User clicks "Packing" tab
  ↓
selectOrCreateColly(collyName) → activeColly = name
  ↓
User Scan Part QR (dari OFF BS atau baru)
  ↓
parseQRCode() → extract partNo, qty, docNo
  ↓
Check: part exists + qty <= target
  ↓
Check: QR not duplicate in packingSession
  ↓
[AUTO CUT & PASTE] Find same partNo in offBsSession
  ↓
IF found: Remove from OFF BS (cut)
  ↓
packingSession.unshift({...}) + save to localStorage
  ↓
triggerPackingSync() → POST to Google Sheets
  ↓
Render packed items in colly
```

### Flow 6: Cashier Mode (Opname Buffer)
```
User enters OPNAME tab
  ↓
Scan Box (RTF-XXX format)
  ↓
opnameBufferBox = boxCode
  ↓
Scan Part 1, 2, 3...
  ↓
addToOpnameBuffer(item) → buffer += 1 qty per scan
  ↓
Scan DIFFERENT box (to finalize)
  ↓
processOpnameBuffer(newBox) → bulk apply to first box
  ↓
For each buffered item: item.locations[box] += qty
  ↓
saveDB() per item + set lastOpnameDate = today
  ↓
clearOpnameBuffer()
  ↓
Show warn if any item exceeds sysQty
```

### Flow 7: Data Sync (Background / Batch Processed)
```
[Every scan → saveDB()]
  ↓
syncQueue.push(item), syncLogs.push(log)
  ↓
Check: syncQueue.length > MAX_QUEUE_SIZE (500)?
  ↓
IF yes: Warn user, prevent new scans
  ↓
[Every 10-15 sec or on button click] processSyncQueue()
  ↓
Check navigator.onLine
  ↓
BATCH LOOP: slice syncQueue into 100-item chunks
  ↓
FOR EACH BATCH:
  POST JSON { action: "sync", data: [100 items], logs: [...] }
  ↓
  to: https://script.google.com/macros/.../exec (Google Sheets)
  ↓
  Response: { status, duplicates, duplicateParts }
  ↓
  IF error: Abort batch, revert queue, show error toast
  ↓
  IF success: Remove batch from queue, continue next batch
  ↓
Clear syncQueue & syncLogs after ALL batches succeed
  ↓
updateSyncUI("🟢 Tersimpan")
```

### Flow 8: Version Check & Auto-Update (Background)
```
[On page load] checkForUpdates()
  ↓
Fetch version.json with cache bypass
  ↓
Parse currentVersion.version
  ↓
Compare with localStorage.appVersion
  ↓
IF new version: Show "Update available" banner
  ↓
User clicks "Update" → Send SKIP_WAITING to SW
  ↓
SW skips waiting, activates new version
  ↓
Browser triggers controllerchange → location.reload()
  ↓
Fresh version loaded
```

---

## Clean Tree

```
WMS/
├─ index.html                  # Entry point HTML
├─ manifest.json              # PWA manifest
├─ sw.js                       # Service Worker (offline cache)
├─ SYSTEM_MAP.md              # Dokumentasi ini
│
├─ css/
│  └─ style.css               # Styling utama (light/dark mode)
│
└─ js/
   ├─ config.js               # Global variables & constants
   ├─ main.js                 # Init: DB, SW, wake lock, scroll listener
   ├─ core.js                 # Logika utama: processScan, tab render
   ├─ database.js             # IndexedDB ops, fetch cloud, sync logic
   ├─ scanner.js              # Html5QrcodeScanner wrapper
   ├─ excel.js                # Import/export Excel, backup/restore JSON
   └─ utils.js                # Utility: feedback tone, toast, dark mode
```

---

## Module Map (The Chapters)

### [config.js](js/config.js)
**Fungsi Publik**: Definisi konstanta & inisialisasi global state  
**Peran**: Repository dari semua variable global yang digunakan lintas file (localItems, syncQueue, filteredItems, currentTab, dll)  
**Caller**: Semua modul lain membaca/menulis variable di sini  
**Side Effects**: Indirect (semua perubahan state via saveDB atau UI event)

---

### [main.js](js/main.js)
**Fungsi Publik**:
- `window.onload()` — Inisialisasi DB, register SW, request wake lock
- `document.addEventListener('click')` — Auto-focus scanner input

**Peran**: Entry point aplikasi; setup lifecycle  
**Caller**: Browser load event  
**Dependensi**: database.js (initDB), core.js (renderLimit handler)  
**Side Effects**: IndexedDB open, SW register, Screen wake lock acquire

---

### [database.js](js/database.js)
**Fungsi Publik Utama**:
- `initDB()` — Buka IndexedDB, fetch data awal dari cloud
- `loadDataFromLocal()` — Read all items dari IndexedDB → localItems
- `saveDB(item, actionName, actionDetail)` — Write item ke IndexedDB + queue sync
- `processSyncQueue()` — POST queued items ke Google Sheets
- `fetchInitialDataFromCloud()` — Fetch data dari Google Sheets di awal
- `triggerOffBsSync()` — Sync off BS session ke cloud

**Peran**: Semua operasi data persistence dan cloud sync; jantung database layer  
**Caller**: main.js (initDB), core.js (saveDB), UI handlers  
**Dependensi**: config.js (localItems, syncQueue), API_URL (Google Sheets)  
**Side Effects**: IndexedDB read/write, POST/GET HTTP requests, localStorage setItem

---

### [core.js](js/core.js)
**Fungsi Publik Utama**:
- `processScan(code)` — Parse scan result, route ke tab handler (SIMPAN/OPNAME/OFF BS/PACKING)
- `selectPartSimpan(item)` — Set active part, render suggestion panel
- `checkSimpanConflict(item, newBox)` — Prompt move/split decision
- `handleOpnameRender()` — Filter & render opname list per box
- `renderDataList(reset)` — Display all items dengan search/filter
- `switchTab(id)` — Change active tab & re-render
- `addToMultiBuffer(item)` — Add to buffer for batch scan
- `processMultiBatchMove(box, actionType)` — Batch move/split buffer

**Peran**: Logika business utama; orchestrator antara UI dan DB  
**Caller**: event handlers (onclick, onkeydown), scanner.js (onScanSuccess)  
**Dependensi**: database.js (saveDB), config.js (localItems, filteredItems)  
**Side Effects**: DOM updates, saveDB calls, feedback() audio/vibrate

---

### [scanner.js](js/scanner.js)
**Fungsi Publik Utama**:
- `openCameraScanner()` — Init Html5QrcodeScanner, open modal
- `onScanSuccess(decodedText, decodedResult)` — Handle QR success, call processScan()
- `closeCameraScanner()` — Stop scanner, clear modal

**Peran**: Wrapper untuk camera-based QR scanning  
**Caller**: HTML button onclick (Camera button), core.js indirect  
**Dependensi**: core.js (processScan), Html5QrcodeScanner library (external)  
**Side Effects**: DOM (camera modal), camera hardware access

---

### [excel.js](js/excel.js)
**Fungsi Publik Utama**:
- `handleImport(input)` — Read Excel, consolidate data, save to IndexedDB + bulk cloud POST
- `exportData()` — Export localItems ke XLSX file
- `exportOffBsData()` — Export offBsSession ke XLSX
- `downloadNewParts()` — Download "PART BARU" list
- `backupJson()` — Backup localItems + offBsSession ke JSON file
- `restoreJson(input)` — Restore dari JSON file

**Peran**: Data import/export; backup/restore utility  
**Caller**: HTML menu buttons (Import/Export)  
**Dependensi**: config.js (localItems), database.js (saveDB, db transaction), XLSX library (external)  
**Side Effects**: IndexedDB clear/write, file download, location.reload()

---

### [utils.js](js/utils.js)
**Fungsi Publik Utama**:
- `feedback(type)` — Trigger visual flash + audio tone + vibrate
- `playTone(freq, type, duration)` — Web Audio API tone generator
- `showToast(message)` — Display floating toast notification
- `toggleDarkMode()` — Switch light/dark theme
- `toggleMenu()` — Show/hide sidebar menu

**Peran**: UI utilities; feedback & styling helpers  
**Caller**: core.js (feedback), event handlers (toggleDarkMode), any scanner success  
**Dependensi**: Web Audio API, DOM manipulation  
**Side Effects**: DOM class toggle, audio play, localStorage setItem (darkMode)

---

### [style.css](css/style.css)
**Peran**: Styling utama; CSS variables untuk theme, layout responsive mobile-first  
**Features**: Dark mode support, PWA standalone styling, tab navigation, status indicators  
**Scope**: Semua element di index.html

---

### [code.gs](code.gs) — Google Apps Script Macro
**Fungsi Publik**:
- `doGet(e)` — GET endpoint; return all items dari DB_MASTER sheet as JSON
- `doPost(e)` — POST endpoint; handle sync actions (sync, sync_off_bs, bulk_import, delete_off_bs)
- `mergeDataFast(sheet, incomingItems)` — Merge logic untuk avoid duplicates

**Peran**: Backend server logic; data persist ke Google Sheets; deduplication  
**Caller**: database.js (fetch, processSyncQueue, triggerOffBsSync)  
**Sheets Used**:
- `DB_MASTER` — Master item data (id, partNo, desc, locType, techName, sysQty, locations JSON, labelIssues JSON)
- `LOG_SCAN` — Audit log (partNo, action, detail, timestamp)
- `TEMP_OFF_BS` — Off-balance-sheet staging (time, box, partNo, qty, docNo, qr, updated_at timestamp)

**Actions Supported**:
- `sync` — Merge regular item updates
- `sync_off_bs` — Append off BS items, detect duplicates via (partNo_docNo)
- `bulk_import` — Replace DB_MASTER from Excel, log all changes
- `delete_off_bs` — Remove items from TEMP_OFF_BS by QR

**Side Effects**: Google Sheets data mutation, sheet operations

---

### [sw.js](sw.js) — Service Worker
**Strategi Caching**: Network-first dengan fallback ke cache  
**Cache Name**: `wms-cache-v27` (versioned per update)

**Cached Assets** (on install):
- `index.html`, `manifest.json`, icons, `version.json`

**Cache Bypass** (never cached):
- `script.google.com/*` → Always fetch fresh (API calls)
- POST requests → Always fresh (sync operations)

**Cleanup**: Old cache versions auto-deleted on activate

**Peran**: Enable offline mode; instant page load  
**Caller**: Browser automatic; registered in main.js  
**Side Effects**: Cache storage, fetch interception

---

### [index.html](index.html) — UI Structure
**5 Main Tabs**:
1. **SIMPAN** — Penyimpanan (single-scan or multi-scan buffer mode)
2. **OPNAME** — Inventory check per box (cashier buffer mode)
3. **DATA** — Search & view all items
4. **OFF BS** — Off-balance-sheet session management
5. **PACKING** — Colly-based packing operations

**Key Modals**:
- Camera Scanner (Html5QrcodeScanner)
- Simpan Conflict (move vs split decision)
- Opname Conflict (location conflict resolution)
- Edit Modal (manual qty/location edit)
- Label Report (quality issues)
- Rak Summary (missing stock per rack)

**Peran**: View layer; all UI elements & form inputs  
**Caller**: HTML onclick handlers, JS event listeners  
**Side Effects**: DOM manipulation, modal display

---

## Module Dependencies Graph

```
ENTRY POINT (index.html)
  ↓
main.js (window.onload)
  ├─ initDB() ← database.js
  ├─ Register sw.js
  ├─ Request wake lock
  └─ Setup scroll listeners → renderLimit pagination
  
core.js (Business Logic)
  ├─ calls: database.js (saveDB, processSyncQueue)
  ├─ calls: config.js (localItems, filteredItems, currentTab)
  ├─ calls: utils.js (feedback, showToast)
  ├─ calls: scanner.js (onScanSuccess → processScan)
  └─ Event handlers: <input onkeydown>, <button onclick>, tabs
  
database.js (Data Persistence)
  ├─ IndexedDB ops (open, read, write, clear)
  ├─ HTTP fetch: code.gs (API_URL)
  └─ localStorage: sync queue, off BS session, packing session
  
scanner.js (Camera Input)
  └─ calls: core.js (processScan) on scan success
  
excel.js (Import/Export)
  ├─ Reads/writes IndexedDB
  ├─ Parses XLSX files
  ├─ Calls: database.js (saveDB, db transactions)
  └─ Generates XLSX files
  
utils.js (UI Helpers)
  ├─ Audio/vibration feedback
  ├─ Toast notifications
  ├─ Dark mode toggle
  └─ Menu toggle
  
config.js (Global State)
  └─ All modules read/write variables here
```

---

## Data & Config

### Lokasi .env / Config Utama
**config.js** (hard-coded):
```javascript
const DB_NAME = 'WMS_Stock_v10';
const API_URL = "https://script.google.com/macros/s/AKfycbxDQBLQEyIaNwQsA2Ubs4KDhFI5v7aNs4pfrs_e8MDmVGwj1zuwHWoCMiGuB27flOsS/exec";
```

**manifest.json**: PWA config (name, icons, theme)

### Skema Data Utama

**IndexedDB `WMS_Stock_v10` → Store `items`**
```javascript
Item {
  id: number (timestamp),
  partNo: string,              // Part number / SKU
  desc: string,                // Deskripsi part
  locType: string,             // "UMUM", "TEKNISI", "OFF BS", "SPAREPART BAIK"
  techName: string,            // Nama teknisi (jika TEKNISI location)
  sysQty: number,              // Target qty dari master
  locations: {                 // Lokasi & qty fisik
    [box]: qty,
    "A-01": 5,
    "B-10": 3
  },
  labelIssues: {               // Label quality issues
    DAMAGED: number,
    NO_LABEL: number
  },
  raw: object                  // Original Excel row
}
```

**localStorage Keys**:
- `wms_packing`: Packing session (JSON array)
- `wms_colly_list`: Colly definitions (JSON array)
- `wms_active_colly`: Active colly ID (string)
- `wms_off_bs`: Off BS session (JSON array)
- `darkMode`: Dark mode toggle (boolean string)

**Sync Queue (Memory)**:
```javascript
syncQueue: Item[]              // Items pending sync
syncLogs: Log[] = [
  { partNo, action: "UPDATE"|"CREATE", detail, timestamp }
]
```

### Lokasi Migration/Seed
Not found — Data dari Google Sheets hanya saat fetch, no dedicated migration.

### Folder Output/Runtime Artifacts
Not found — Pure client-side app; no server-side artifacts.

---

## External Integrations

### Google Sheets API (code.gs Macro)
**Service**: `https://script.google.com/macros/s/AKfycbxDQBLQEyIaNwQsA2Ubs4KDhFI5v7aNs4pfrs_e8MDmVGwj1zuwHWoCMiGuB27flOsS/exec`  
**Caller Modules**: database.js:
- `fetchInitialDataFromCloud()` — GET data awal (doGet endpoint)
- `processSyncQueue()` — POST items & logs untuk sync (doPost:action=sync)
- `triggerOffBsSync()` — POST off BS session (doPost:action=sync_off_bs)
- `handleImport()` in excel.js — POST bulk import (doPost:action=bulk_import)

**HTTP Methods**:
- `GET /exec` → Fetch all items dari DB_MASTER sheet
- `POST /exec` → Sync/import data based on action field

**Payload Format**:

```javascript
// Regular Sync
{ 
  action: "sync",
  data: [Item[], Item[], ...],        // Max 100 items per batch
  logs: [
    { partNo, action: "UPDATE"|"CREATE", detail, timestamp }
  ]
}

// Off BS Sync
{ 
  action: "sync_off_bs",
  data: [
    { time, box, partNo, qty, docNo, qr, updated_at }
  ]
}

// Bulk Import from Excel
{ 
  action: "bulk_import",
  data: [Item[], Item[], ...],
  logs: [...]
}

// Delete Off BS (manual cleanup)
{ 
  action: "delete_off_bs",
  data: [{ qr, partNo }, ...]
}
```

**Response Format**:
```javascript
{
  status: "success" | "error",
  message: "string",
  data: [Item[]] (only for doGet),
  duplicates: number,           // Count of duplicate off BS items
  duplicateParts: [partNo[], ...], // List of duplicate part numbers
  inserted: number              // Count of new off BS items inserted
}
```

**Google Sheets Sheets**:
- `DB_MASTER` — Master item catalog (id, partNo, desc, locType, techName, sysQty, locations JSON, labelIssues JSON)
- `LOG_SCAN` — Audit log (partNo, action, detail, timestamp) — appended on every sync
- `TEMP_OFF_BS` — Off-balance-sheet staging (auto-appended, no delete on client side)

**Error Handling**:
- Network error → Keep queue in syncQueue, retry next cycle
- API error (400, 500) → Show error toast, log to console
- Offline (navigator.onLine === false) → Skip sync, keep queue, show offline indicator

---

### QR Code Format Parsing (Configurable)
**Module**: config.js → QR_PARSERS object

**Supported Formats** (in order of matching priority):

1. **Standard (Baru)** — Pipe-separated format
   ```
   Pattern: PART_NO|QTY|SERIAL|DOC_NO
   Example: KE-010015-00A|1| |SJOB/SKM-MGL/26/03/28/008
   Extract: partNo, qty, docNo
   ```

2. **SCL/MGL (Lama)** — Space-separated format
   ```
   Pattern: DOC_NO QTY UNIT_TYPE PART_NO
   Example: SCL/MGL/25/12/17/010 1 PS-PLD43BUG5959 XV-033284-00A
   Extract: docNo, qty, partNo (unit type ignored)
   ```

3. **SCL Legacy** — Simplified SCL format
   ```
   Pattern: SCL/ QTY PART_NO
   Example: SCL/ 1 XV-033284-00A
   Extract: docNo="SCL", qty, partNo
   ```

4. **Simple Fallback** — Any text
   ```
   Pattern: .+ (matches anything)
   Extract: partNo=raw_code, qty=1, docNo="AUTO"
   ```

**Parser Configuration** (in config.js):
```javascript
const QR_PARSERS = {
  standard: { name: '...', pattern: /.../, extract: (match) => {...} },
  sclMGL: { name: '...', pattern: /.../, extract: (match) => {...} },
  scl2025: { name: '...', pattern: /.../, extract: (match) => {...} },
  simple: { name: '...', pattern: /.../, extract: (match) => {...} }
};
```

**Box Pattern Detection**:
- Box format: `/^[A-Z][0-9]{0,2}-[0-9]{2,3}$/` (e.g., A-01, B-123, K-999)
- OFF BS box: Must start with `RTF` (e.g., RTF-001, RTF-A05)

**Usage in Flows**:
- core.js:parseQRCode() tries each parser in order
- First match wins (fallback always matches)
- Result includes parser metadata for logging

---

### Html5QrcodeScanner Library (External)
**Fungsi**: Camera-based QR/barcode real-time scanning  
**Used in**: scanner.js:openCameraScanner()  
**CDN**: Loaded via `<script src="https://unpkg.com/html5-qrcode"></script>` in index.html

**API Used**:
```javascript
new Html5QrcodeScanner(
  "reader",  // DOM element ID
  { fps: 10, qrbox: {width: 250, height: 250}, aspectRatio: 1.0 },
  false      // Verbose
);
scanner.render(onScanSuccess, onScanError);
scanner.clear();  // Stop & cleanup
```

**Callbacks**:
- `onScanSuccess(decodedText, decodedResult)` → Extract raw QR string, call processScan()
- `onScanError(errorMessage)` → Ignored (suppress "QR could not be decoded" spam)

---

### SheetJS / XLSX Library (External)
**Fungsi**: Excel file parsing (.xlsx, .xls) and generation  
**Used in**: excel.js (handleImport, exportData, backupJson)  
**CDN**: `<script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>`

**API Used**:
```javascript
// Parse Excel file
const wb = XLSX.read(arrayBuffer, { type: 'array' });
const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });

// Generate Excel file
const ws = XLSX.utils.json_to_sheet(data);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Sheet Name");
XLSX.writeFile(wb, "filename.xlsx");
```

**Consolidation Logic** (in handleImport):
- Map existing items by partNo
- Merge new data with location pool
- FG filter (only RECEIPT transactions for OFF BS)
- Deduplication by (partNo, box, docNo)

---

### Font Awesome Icons (CDN)
**CDN**: `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css`  
**Usage**: Icon classes in HTML (fa-bars, fa-search, fa-camera, etc.)  
**Used by**: All UI buttons, indicators, badges

---

### Web APIs (Browser Native)

**IndexedDB**:
- Open database: `DB_NAME = 'WMS_Stock_v10'`
- Store: `items` with keyPath `id`
- Operations: add, put, get, getAll, clear (in database.js)

**localStorage**:
- Keys: `wms_packing`, `wms_off_bs`, `wms_colly_list`, `wms_active_colly`, `darkMode`, `appVersion`, `lastCloudSyncTime`
- Used by: config.js (offBsSession, packingSession), utils.js (darkMode)

**Service Worker API**:
- Register in main.js: `navigator.serviceWorker.register('sw.js')`
- Message handler: `controller.postMessage({ type: 'SKIP_WAITING' })`

**Web Audio API**:
- Context: `new AudioContext()` in utils.js
- Generate tones: OscillatorNode + GainNode
- Used for: Feedback tones (success, error, warning, scan)

**Vibration API**:
- Navigator.vibrate() in utils.js
- Used for: Haptic feedback on scan success

**Screen Wake Lock API**:
- In main.js: `navigator.wakeLock.request('screen')`
- Keeps screen on during scanning session

**Manifest & PWA**:
- manifest.json: App name, icons, display mode, theme color
- Used for: Installable web app, standalone display

---

## Risks / Blind Spots (Continuously Updated)

**Latest Improvements** (2026-04-22):
- ✅ **Data Persistence on Refresh**: syncQueue & syncLogs now persisted to localStorage, survive page refresh
- ✅ **Qty Overflow Protection**: Added check in SIMPAN tab to prevent scanning more than sysQty (matches OFF BS logic)
- ✅ **Opname Filter Logic Fixed**: Rewritten handleOpnameRender() for correct box filtering:
  - SEMUA: Shows all parts in selected box
  - SELISIH: Shows only parts with qty mismatch
  - BELUM: Shows only parts with 0 qty in box
- ✅ **Multi-Scan Logic Fixed**: isMultiScan check in processScan() now routes correctly to processMultiBatchMove
- ✅ **Redundant Function Removed**: Obsolete processSimpanBuffer() deleted
- ✅ **Buffer Validation Added**: All buffers (multiBuffer, simpanBuffer, opnameBuffer) now validated as arrays

**Status**: 8 critical improvements implemented since 2026-04-21:
- ✅ Batch sync queue (MAX_SYNC_BATCH=100, MAX_QUEUE_SIZE=500)
- ✅ Auto SW cache versioning with user prompt
- ✅ Modular QR parser (configurable in config.js)
- ✅ Multi-scan mode logic corrected
- ✅ Buffer clearing edge-case fixed
- ✅ syncQueue persistence across refresh
- ✅ Qty overflow halt in SIMPAN
- ✅ Opname filter rewritten for correct behavior

### Remaining Risks

1. **Google Sheets API Dependency** (Resilience planned)
   - Cloud sync will fail if API URL changes or macro disabled
   - Fallback: Supabase hybrid storage planned
   - Risk: Data stale if sync error not handled
   - Mitigation: Check `navigator.onLine` before sync, queue persists offline

2. **Concurrent Edit Conflicts** (Versioning planned)
   - No lock mechanism; 2+ devices editing same part → last-write-wins
   - Planned: Add version + timestamp tracking
   - Risk: Qty overwrite without merge logic
   - Workaround: Manual conflict resolution in edit modal

3. **Performance for 10,000+ Items** ✅ **VERIFIED FIXED**
   - ✅ Batch sync (100 items/POST) prevents OOM crashes
   - ✅ Queue overflow protection (MAX_QUEUE_SIZE=500)
   - ✅ Render layer uses pagination (renderLimit=50, infinite scroll)
   - Risk: Eliminated

4. **QR Format Parsing** ✅ **CONFIGURABLE NOW**
   - ✅ Configurable QR_PARSERS in config.js
   - ✅ Supports: Standard (pipe), SCL format (lama), simple fallback
   - ✅ Easy to add new formats via QR_PARSERS config (documented in AGENTS.md)
   - Risk: Mitigated

5. **Storage Limit** (Archival planned)
   - IndexedDB ~50MB, localStorage ~5-10MB limits
   - Planned: Archive old logs after 30 days
   - Risk: Storage overflow if data not pruned
   - Current: Manual cleanup via "Reset Opname" or "Reset DB"

6. **Service Worker Cache Stale** ✅ **AUTO-UPDATE ACTIVE**
   - ✅ Auto version check (version.json + SKIP_WAITING message)
   - ✅ User prompted for update after 3 sec on load
   - ✅ Cache cleanup on activation
   - ✅ Old cache versions auto-deleted
   - Risk: Eliminated

7. **No Authentication / Authorization**
   - Pure client-side, no user login
   - Planned: Add OAuth2 + deviceId tracking
   - Risk: No audit trail of who scanned what
   - Workaround: Check LOG_SCAN sheet in Google Sheets for timestamps

8. **Excel Import Logic Complexity** (Refactor planned)
   - consolidateExcel() logic complex; FG filtering hardcoded
   - Risk: Import breaks if Excel format changes
   - Workaround: Test import on sample file first, check preview

9. **Limited Export Formats** (CSV planned for next sprint)
   - Currently: Excel + JSON only
   - Planned: Add CSV export
   - Risk: Data hard to analyze elsewhere
   - Workaround: Import Excel file into any tool that supports XLSX

10. **Offline Queue Accumulation** ✅ **FULLY PROTECTED**
    - ✅ MAX_SYNC_BATCH = 100 items per POST
    - ✅ MAX_QUEUE_SIZE = 500 prevents overflow
    - ✅ Automatic log cleanup (keep last 100 logs)
    - ✅ Alert user if queue exceeds limit
    - ✅ Graceful degradation in offline mode
    - Risk: Eliminated

11. **Multi-Scan Mode Buffer Edge Cases** ✅ **JUST FIXED**
    - ✅ multiBuffer now validated as array in addToMultiBuffer, renderMultiBuffer, clearMultiBuffer
    - ✅ processScan() checks isMultiScan first before single-scan logic
    - ✅ simpanBuffer also validates and clears properly on mode toggle
    - Risk: Eliminated

---

**Last Updated**: 2026-04-22  
**Latest Fixes**: Multi-scan logic, buffer validation, redundant code removal  
**Next Priority**: Conflict detection & merge, CSV export, archival strategy, OAuth2 auth
