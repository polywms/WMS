# SYSTEM MAP - WMS Magelang V6

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

### Flow 5: Data Sync (Background)
```
[Every scan → saveDB()]
  ↓
syncQueue.push(item), syncLogs.push(log)
  ↓
[Every 10-15 sec or trigger] processSyncQueue()
  ↓
Check navigator.onLine
  ↓
POST JSON { action: "sync", data: [...], logs: [...] }
  ↓
to: https://script.google.com/macros/.../exec (Google Sheets)
  ↓
Response: { status, duplicates, duplicateParts }
  ↓
Clear syncQueue, syncLogs if success
  ↓
updateSyncUI("🟢 Tersimpan")
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

### [sw.js](sw.js)
**Strategi Caching**: Network-First untuk HTML/CSS/JS (offline fallback dari cache)  
**Exclusions**: 
- Google Sheets API (script.google.com) → langsung fetch, tidak di-cache
- POST requests (sync) → langsung fetch

**Peran**: Enable offline functionality via caching; improve load time  
**Caller**: Browser (registered di main.js), automatic on page load

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

### Google Sheets API
**Service**: https://script.google.com/macros/s/.../exec (Google Apps Script)  
**Caller**: database.js:
- `fetchInitialDataFromCloud()` — GET data awal
- `processSyncQueue()` — POST items & logs untuk sync
- `triggerOffBsSync()` — POST off BS session

**Method**: `fetch(API_URL, { method: "POST", body: JSON.stringify(payload) })`

**Payload Format**:
```javascript
// Sync regular items
{ action: "sync", data: [Item[]], logs: [Log[]] }

// Sync off BS
{ action: "sync_off_bs", data: [OffBsItem[]] }

// Bulk import from Excel
{ action: "bulk_import", data: [Item[]], logs: [Log[]] }
```

**Response**:
```javascript
{
  status: "success" | "error",
  duplicates: number,              // (off BS only)
  duplicateParts: string[]         // (off BS only)
}
```

### Html5QrcodeScanner (External Library)
**Fungsi**: Camera-based QR/barcode scanning  
**Used in**: scanner.js:openCameraScanner()  
**CDN**: Assumed loaded in HTML (not in workspace)

### SheetJS / XLSX (External Library)
**Fungsi**: Excel file parsing & generation  
**Used in**: excel.js (import/export)  
**CDN**: Assumed loaded in HTML

### Font Awesome Icons (CDN)
**CDN**: https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css  
**Used**: Icon classes di HTML (fa-bars, fa-search, etc.)

---

## Risks / Blind Spots (Continuously Updated)

**Status Update**: 3 critical improvements implemented 2026-04-21:
- ✅ Batch sync queue (MAX_SYNC_BATCH=100)
- ✅ Auto SW cache versioning
- ✅ Modular QR parser (configurable)

### Remaining Risks

1. **Google Sheets API Dependency** (Resilience planned)
   - Cloud sync will fail if API URL changes or macro disabled
   - Fallback: Supabase hybrid storage planned
   - Risk: Data stale if sync error not handled

2. **Concurrent Edit Conflicts** (Versioning planned)
   - No lock mechanism; 2+ devices editing same part → last-write-wins
   - Planned: Add version + timestamp tracking
   - Risk: Qty overwrite without merge logic

3. ~~**Performance for 10,000+ Items**~~ **FIXED**
   - ✅ Batch sync (100 items/POST) prevents OOM crashes
   - ✅ Queue overflow protection (MAX_QUEUE_SIZE=500)
   - Render layer still uses pagination (renderLimit=50)

4. ~~**QR Format Parsing Hardcoded**~~ **FIXED**
   - ✅ Configurable QR_PARSERS in config.js
   - Supports: Standard (pipe), SCL format, simple fallback
   - Easy to add new formats via QR_PARSERS config

5. **Storage Limit** (Archival planned)
   - IndexedDB ~50MB, localStorage ~5-10MB limits
   - Planned: Archive old logs after 30 days
   - Risk: Storage overflow if data not pruned

6. ~~**Service Worker Cache Stale**~~ **FIXED**
   - ✅ Auto version check (version.json + SKIP_WAITING)
   - ✅ User prompted for update after 3 sec on load
   - ✅ Cache cleanup on activation
   - Risk: Eliminated

7. **No Authentication / Authorization**
   - Pure client-side, no user login
   - Planned: Add OAuth2 + deviceId tracking
   - Risk: No audit trail of who scanned what

8. **Excel Import Logic Complexity** (Refactor planned)
   - consolidateExcel() logic complex
   - FG filtering hardcoded
   - Risk: Import breaks if Excel format changes

9. **Limited Export Formats** (CSV planned for next sprint)
   - Currently: Excel + JSON only
   - Planned: Add CSV export
   - Risk: Data hard to analyze elsewhere

10. ~~**Offline Queue Accumulation**~~ **FIXED**
    - ✅ MAX_SYNC_BATCH = 100 items per POST
    - ✅ MAX_QUEUE_SIZE = 500 prevents overflow
    - ✅ Automatic log cleanup (keep last 100 logs)
    - ✅ Alert user if queue exceeds limit
    - Risk: Eliminated

---

**Last Updated**: 2026-04-21  
**Improvements**: Batch sync, cache versioning, modular QR parser  
**Next Priority**: Conflict detection, CSV export, archival strategy
