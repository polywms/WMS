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
- **Audio**: Web Audio API (feedback tone melalui master gain internal 100% dan compressor)
- **Device**: Web vibration API + Screen Wake Lock

**Pola Arsitektur**  
Arsitektur layering sederhana: View (HTML/Tab) → Controller (core.js processScan) → Service (CRUD functions) → Repository (saveDB/loadDataFromLocal) → Storage (IndexedDB + localStorage) → Cloud (Google Sheets via API).

**Role & Lokasi Fisik**
- Startup meminta pilihan Admin (password diverifikasi server) atau User (langsung ke Cari).
- Password Admin dibuat lewat `setupAdminPassword()` dengan minimum 4 karakter; password yang lebih panjang tetap diterima dan server memvalidasi batas minimum saat setup serta login.
- User hanya dapat mencari data lokal dengan mengetik atau scan kamera; navigasi dan handler membatasi tab serta aksi tulis. Pilihan User diingat, data lokal tampil segera, lalu GET read-only memperbarui stok dan lokasi dari cloud di latar belakang; bila data berubah dan tersimpan, halaman reload otomatis ke Cari.
- Refresh User tidak menampilkan kontrol sinkronisasi manual dan tidak menulis ke cloud. `SYS_QTY` dan `LOCATIONS` mengikuti cloud; record dengan perubahan lokal pending tetap mempertahankan lokasi lokal, sementara `SYS_QTY` tetap diperbarui.
- Filter lokasi Admin memilih `SPAREPART BAIK` sebagai default saat tersedia. SIMPAN, relokasi, edit hitungan Opname aktif, dan OPNAME hanya menerima item dengan `LOC_TYPE` tersebut; jenis lain tetap tersedia untuk pencarian DATA.
- Sesi Admin berlaku 8 jam; semua POST tulis diverifikasi token di `code.gs`. Guard UI tidak menggantikan validasi server.
- Import stock mencocokkan identitas part, memperbarui hanya qty dan timestamp sinkronisasi server untuk record lama, menambah record baru tanpa lokasi, dan merekonsiliasi ID server.
- Kolom G `DB_MASTER` diproteksi dari editor spreadsheet. Import tidak menulis ulang kolom G record lama; part baru diinisialisasi dengan lokasi kosong. Lokasi hanya berubah lewat alur scan SIMPAN.
- Kode lokasi legacy dapat menjadi sumber pemindahan keluar, tetapi tidak dapat menjadi tujuan baru.

---

## Core Logic Flow (Function-Level Flowchart)

### Flow 1: Pemindaian Normal (SIMPAN Tab)
```
User Scan Code
  ↓
handleInputKeyDown() [core.js]
  ↓
(optional) Box-to-Box Merge Mode [core.js] — saat aktif tampilkan box asal dan tujuan di bawah scanner; validasi box asal terhadap part lokal saat discan dan cocokkan key lokasi tanpa membedakan kapital/spasi; tujuan oranye saat standby/invalid dan hijau setelah scan tujuan valid; pasangan yang selesai tetap ditampilkan hijau beserta asal/tujuannya; scan box berikutnya memulai pasangan baru dan mengembalikan tujuan ke oranye; pasangan valid meminta konfirmasi pertama kali, lalu Yes to All melewati konfirmasi untuk pasangan berikutnya hingga mode dimatikan; hitungan opname per part ikut dipindahkan dan ditambahkan ke hitungan box tujuan.
  ↓
processScan(code) [core.js] — Parse & route per tab
  ↓
processScan(code) [core.js] — Parse & route per tab
  ↓
filteredItems.find() — Match part; pastikan LOC_TYPE = SPAREPART BAIK
  ↓
selectPartSimpan(item) [core.js] — Select active part
  ↓
User Scan Box or rack-level location / Input Location
  ↓
checkSimpanConflict() [core.js] — Validate move/split
  ↓
executeSimpanAction() [core.js] — Update item.locations
  ↓
saveDB(item) [database.js] — Write to IndexedDB immediately + persist sync queue
  ↓
renderSimpanList() [core.js] — Update UI
  ↓
User opens sync status → Sync dialog [database.js] — show queued location and Opname tables; canceling a part restores the latest Cloud record (or removes an unpublished local record)
  ↓
Upload lokasi box & hasil Opname [database.js] — POST queued records only
```

**Multi-Scan alternative**: Buffer selected parts, scan a destination, then choose Move/Split per conflicting part or apply either action to all conflicts; parts without a conflicting location are added directly.

### Flow 2: Opname (Inventory Check)
```
Scan box or rack level → handleOpnameScan() → setOpnameBoxFilter()
  ↓
Box QR (contoh `BUFFER-E-A1-01`) or rack-level QR `B-B1` / alias `B-B-1` is recognized in OPNAME; the alias is normalized to `B-B1`; rack scan includes direct rack locations and child boxes such as `B-B1-01`
  ↓
Batasi daftar dan scan part ke `LOC_TYPE` SPAREPART BAIK
  ↓
handleOpnameRender() — Show all registered parts at the active location; rack scans render sorted child-box groups with three-line item/status/physical-count summaries; only one group can be open at a time
  ↓
Scan part QR → handleOpnameScan() — Reject parts not registered directly or in a child box of the active rack
  ↓
Each box/rack remains membership-only in `locations`; the active box or rack aggregate is stored in `item.opnameCounts[target]`
  (a missing count is uncounted and displays as `-/SYS_QTY`; an exact positive aggregate match to `SYS_QTY` counts as complete even when another registered box has zero stock)
  ↓
Each scan reads saved target count, adds 1, and persists immediately; badge count sums physical counts across locations and uses gray for uncounted, green for exact match, and light red for a partial/different total; rack counts aggregate any prior child-box counts and replace those child counts after the first rack-level scan
  ↓
The browser serializes scan writes; a failed write leaves the old X unchanged and reports an error
  ↓
addToOpnameBuffer() — Increment the active box/rack count; if the aggregate across counted locations exceeds `SYS_QTY`, ask for confirmation
  ↓
Confirmed scan beyond Y also persists X+1 immediately
  ↓
Buffer controls decrement X by one or reset that part to 0; each correction persists immediately
  ↓
Persist recent scan list in localStorage; IndexedDB `opnameCounts` is authoritative; an exact aggregate match to `SYS_QTY` is complete even if an empty box has no positive count entry
  ↓
Clickable opname stats → filter by OK, selisih, belum, or counted quantity
  ↓
Dashboard Lokasi → heatmap jumlah part unik per box, daftar part belum selesai opname, box kosong, dan ringkasan opname
  ↓
Registry box dibaca dari sheet BOX_REGISTRY; scan box baru lalu simpan sebagai batch, atau hapus mapping dengan konfirmasi tanpa mengubah lokasi/part di DB_MASTER
  ↓
Klik box dashboard → setOpnameBoxFilter() → OPNAME pada box pilihan
  ↓
Changing locations through SIMPAN invalidates affected per-part counts; OPNAME never changes location membership
  ↓
Reset current location → clear its counts while preserving membership; destructive part removal remains available only for a specific box
  ↓
Each scan/correction → saveDBBatch() → IndexedDB + persistent upload queue (no automatic cloud request)
  ↓
Cloud schema stores `OPNAME_COUNTS`; legacy `OPNAME_COMPLETED` values remain accepted for compatibility but do not affect current Opname status
```

### Simplified Sync Rules (current)
- Upload perubahan lokal menulis `LOCATIONS` dan `OPNAME_COUNTS`; legacy `OPNAME_COMPLETED` is retained for compatibility; identity and revision are used only for matching and conflict detection.
- The local outbox records pending `location`/`opname` categories for the sync dialog; those display-only categories are not sent in the Cloud payload. Canceling a part removes its full pending snapshot and restores its latest Cloud row; a part absent from Cloud is removed locally.
- Upload normal tidak menulis `SYS_QTY` atau metadata master. Import stock adalah alur yang mengubah `SYS_QTY` di cloud.
- Download selalu menerapkan `SYS_QTY` cloud ke lokal, termasuk pada record ber-outbox, dan memperbarui snapshot antrean tanpa mengubah revision. Download manual Admin dapat menerapkan `LOCATIONS` cloud setelah konfirmasi konflik; refresh User menerapkan lokasi cloud otomatis. Record dengan perubahan pending mempertahankan lokasi lokal.
- `LOCATIONS` menyimpan membership box/tingkat; `OPNAME_COUNTS` menyimpan hitungan positif per target. Total positif yang tepat sama dengan `SYS_QTY` dianggap selesai meski ada box kosong tanpa hitungan positif; selain itu part belum lengkap tetap ditampilkan `-/SYS_QTY`.
- Status OPNAME langsung match saat total hitungan fisik positif sama dengan `SYS_QTY`; jika belum match, semua lokasi harus memiliki hitungan atau tercakup hitungan rak agar status tidak pending. Upload hasil tetap manual.
- `BOX_REGISTRY` menyimpan kode box yang discan sebagai daftar bersama. Penambahan dilakukan append-only dalam satu batch; penghapusan mapping terpisah dari DB_MASTER dan tidak mengubah part/lokasi.

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
offBsSession.unshift() → localStorage (immediate local operation)
  ↓
Pending OFF BS data stays local; cloud menus are disabled and this workflow does not auto-upload
```

### Flow 4: Multi-Scan (Buffer Mode)
```
toggleMultipleScanMode() → simpanMode = 'multiple'
  ↓
Scan Part → addToMultiScan() → multiScanBuffer[] (origin snapshot + selection)
  ↓
Render rows with origin, checkbox, and remove control
  ↓
Scan destination Box → validate and confirm batch move
  ↓
  For checked parts: replace old locations with destination box
  ↓
saveDB() per item + history + sync queue
  ↓
  Keep unchecked parts in buffer; refresh SIMPAN list and focus scan input after confirmation
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
packingSession.unshift({...}) + save to localStorage (immediate local operation)
  ↓
Cloud upload does not run automatically; this menu is currently disabled
  ↓
Render packed items in colly
```

### Flow 6: Cashier Mode (Opname Buffer)
```
User enters OPNAME tab
  ↓
Scan box code
  ↓
opnameBufferBox = boxCode
  ↓
Scan Part 1, 2, 3...
  ↓
addToOpnameBuffer(item) → session count +1; every scan persists the session in localStorage
  ↓
Reset current box/rack → clears target count keys while preserving membership; clear contents remains box-only removes both membership and count through the local upload queue
  ↓
Each saveDBBatch() writes item + outbox entry in one IndexedDB transaction
  ↓
Keep the committed count in `item.opnameCounts[box]`; never alter location membership during counting
```

### Flow 7: Data Sync (Background / Batch Processed)
```
[Every scan → saveDB()/saveDBBatch()]
  ↓
One IndexedDB transaction writes item + item-keyed outbox; startup migrates legacy localStorage queue
  ↓
[On startup] Load IndexedDB, validate duplicate identity keys, merge same-part duplicates, and repair queue before any upload
  ↓
[On explicit Upload action] processSyncQueue()
  ↓
Upload master queue in batches without removing entries before server acknowledgment
  ↓
BATCH LOOP: slice syncQueue into 100-item chunks
  ↓
FOR EACH BATCH:
  POST JSON { action: "sync", data: [{ identity, LOCATIONS, OPNAME_COUNTS, OPNAME_COMPLETED, revision }], logs: [...] }
  ↓
  to: https://script.google.com/macros/.../exec (Google Sheets)
  ↓
  Under ScriptLock, validate all expected revisions before writes
  Response: { status: "success", revisions } or { status: "conflict", conflicts }
  ↓
IF error/offline/conflict: Keep outbox unchanged; conflicts show local/cloud snapshots and per-item choices
  ↓
IF success: Acknowledge revisions and remove only unchanged submitted snapshots; continue next batch
  ↓
Keep the bounded local sync log after outbox acknowledgment
  ↓
Aggregate every upload/download result; any partial failure reports "Sync gagal sebagian" instead of "Tersinkron"
  ↓
updateSyncUI("Upload berhasil; cloud mengonfirmasi revision")
```

### Flow 8: Role & Stock Import
```
Pilih Admin/User saat startup
  ↓
Admin → admin_login → hash+salt diverifikasi dari WMS_USER_ROLE → token sesi 8 jam
User → tab Cari saja → ketik cariInput atau scan kamera → render data lokal read-only
  ↓
GET read-only otomatis di latar belakang → merge aman ke IndexedDB → reload hanya jika record benar-benar berubah
  ↓
Admin import stock → Excel dikelompokkan dengan identitas part/type/teknisi
  ↓
IndexedDB: record lama mempertahankan lokasi dan metadata, hanya sysQty berubah; record baru tanpa lokasi
  ↓
POST bulk_import dengan token → Apps Script lock → record lama update kolom qty dan timestamp sinkronisasi server,
record baru append dengan locations={} → respons pemetaan ID canonical
  ↓
Lokal merekonsiliasi ID dan antrean pending; upload gagal tidak menghapus data/antrean lokal
```

### Flow 9: Version Check & Auto-Update (Background)
```
[On page load] checkForUpdates()
  ↓
Fetch version.json with cache bypass
  ↓
Parse currentVersion.version
  ↓
Display current app version below the WMS title in the fixed header
  ↓
Register sw.js?v=currentVersion with updateViaCache: none
  ↓
Install versioned worker and cache namespace
  ↓
Precache local HTML, CSS, JavaScript, manifest, and icons
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
**Side Effects**: State setup dari localStorage; buffer Multi-Scan disimpan persisten oleh core.js.

---

### [auth.js](js/auth.js)
**Fungsi Publik Utama**:
- `initializeRoleSession()` — Pulihkan sesi Admin atau tampilkan role gate
- `authenticateAdmin()` / `chooseUserRole()` / `endRoleSession()` — Autentikasi Admin, mulai User, atau cabut sesi
- `requireAdminAccess()` / `postWmsAction()` — Guard aksi lokal dan POST terotorisasi

**Peran**: Role state, pembatasan UI, dan helper request ber-token  
**Caller**: `main.js`, `core.js`, `database.js`, `excel.js`, serta handler role di `index.html`  
**Side Effects**: Membaca/menulis localStorage dan request HTTP login/tulis terotorisasi.

---

### [main.js](js/main.js)
**Fungsi Publik**:
- `window.onload()` — Inisialisasi DB, pulihkan sesi role, register SW, request wake lock, dan tampilkan waktu upload DATA STOCK terakhir
- `checkForUpdates()` — Muat versi dari `version.json`, tampilkan di bawah judul header, dan cek pembaruan cache
- `document.addEventListener('click')` — Auto-focus scanner input

**Peran**: Entry point aplikasi; setup lifecycle  
**Caller**: Browser load event  
**Dependensi**: auth.js (role session), database.js (initDB), core.js (renderLimit handler, SIMPAN mode state)
**Side Effects**: IndexedDB open, baca waktu upload DATA STOCK dari localStorage, SW register, Screen wake lock acquire
**Multi-Scan**: Memulihkan mode, ikon, dan buffer persisten; buffer tetap terlihat walau mode dimatikan.

---

### [database.js](js/database.js)
**Fungsi Publik Utama**:
- `initDB()` — Buka IndexedDB dan tampilkan data lokal tanpa request cloud
- Startup migration canonicalizes `locations` as box membership and removes zero/orphan `opnameCounts` from items/outbox
- IndexedDB v2 stores `items`, `outbox`, and migration markers; legacy `wms_syncQueue` is imported before cleanup
- `loadDataFromLocal()` — Read all items dari IndexedDB → localItems
- `saveDB()` / `saveDBBatch()` — Atomically write item and outbox entry
- `processSyncQueue()` — Upload outbox snapshots, accept revision acknowledgments, retain failures/conflicts
- `resolveSyncConflict()` / `resolveAllSyncConflicts()` — Per-record or atomic batch priority for Cloud vs. Local conflict resolution
- `uploadToServer()` — Upload pending master records from the sync dialog
- `downloadFromServer()` — GET and merge cloud records without deleting local-only or pending data; Admin can apply Cloud locations after confirmation and User refresh applies them automatically for non-pending records
- `refreshUserDataInBackground()` — User-only read refresh; keeps cached data visible and reloads only after changed cloud data is committed locally
- `window.manualSync()` — Open the manual Upload/Download dialog

**Peran**: Semua operasi data persistence dan cloud sync; jantung database layer  
**Caller**: main.js (initDB), core.js (saveDB), UI handlers  
**Dependensi**: auth.js (Admin-authorized writes), config.js (localItems, syncQueue), API_URL (Google Sheets)  
**Side Effects**: IndexedDB item/outbox read/write, sync-log localStorage, background User GET and user-triggered Admin POST/GET requests
**Sync Status**: User GET refresh runs on role selection and User startup; Admin cloud operations remain explicit through the sync dialog. No periodic or online-event retry.

---

### [core.js](js/core.js)
**Fungsi Publik Utama**:
- `toggleMobileNavigation()` — Collapse or expand mobile navigation without changing the active tab
- `processScan(code)` — Parse scan result, route ke tab handler (SIMPAN/OPNAME/OFF BS/PACKING)
- `selectPartSimpan(item)` — Set active part, render suggestion panel; qty 0 tidak dirender di SIMPAN/OPNAME
- `switchTab(id)` — Enforce User-only Cari and stop SIMPAN modes safely while preserving confirmed buffer
- `toggleMultipleScanMode()` / `toggleBoxToBoxMode()` / `updateSimpanModeControls()` — Keep SIMPAN relocation modes visually synchronized and mutually exclusive
- `applyBoxToBoxSelection()` — Move location membership and merge per-box OPNAME counts into the destination box
- `confirmBoxToBoxYesToAll()` — Gabungkan semua part saat ini dan aktifkan auto-approval sampai mode dimatikan
- `updateBoxToBoxIndicator()` — Render box sumber/tujuan dengan status validasi tujuan
- `checkSimpanConflict(item, newBox)` — Prompt move/split decision
- `handleOpnameRender()` / `setOpnameFilter()` — Filter Opname by final comparison/count status; rack scans show naturally sorted box groups with per-group difference/uncounted totals, and only one group opens at a time
- `openRakModal()` / `renderRakSummary()` — List populated racks and summarize OK, selisih, belum, and counted pcs by location
- `renderRakDashboard()` / `renderRakHeatmap()` / `renderRakUncounted()` / `renderRakEmptyBoxes()` — Heatmap part unik, part belum selesai opname, dan box kosong berdasarkan registry cloud
- `loadBoxRegistry()` / `saveBoxRegistryDraft()` / `deleteBoxRegistry()` — Read shared box mapping; append scanned boxes or remove a mapping after confirmation without changing stock locations; registry codes are validated as `X-XY-YY` with an optional prefix and filtered by rack group
- `getOpnameBufferQty(itemId, item)` — Read the active box/rack aggregate, including prior child-box counts before rack-level counting starts
- `getOpnameTotalCount(item)` — Sum persisted physical counts across locations without double-counting rack aggregates; the active-box badge still includes counts from other boxes
- `saveManualEdit()` — Edit the active box/rack physical Opname count without changing locations
- `removeOpnamePartFromActiveBox()` — Remove a part and its count from only the active OPNAME box through the local upload queue
- `resetCurrentBoxOpname()` — Remove saved count keys for active box/rack without changing membership
- `clearCurrentBoxOpnameContents()` — Remove active specific-box membership and counts through one local upload batch
- `confirmOpnameOverScan()` — Confirm aggregate physical count that exceeds `SYS_QTY`
- `decrementOpnameBuffer()` / `removeFromOpnameBuffer()` — Reduce one or all counted units for a part
- `renderDataList(reset)` — Display all items dengan search/filter
- `switchTab(id)` — Change active tab & re-render
- `addToMultiScan(item)` — Add part with source-location snapshot and selection state
- `processMultiScan(box)` — Confirm and move selected parts as a batch
- `renderMultiScanList()/removeFromMultiScan()` — Render and manage buffered parts
- Legacy location codes remain valid as move sources but are rejected as destinations in SIMPAN/client and server validation

**Peran**: Logika business utama; orchestrator antara UI dan DB  
**Caller**: event handlers (onclick, onkeydown), scanner.js (onScanSuccess)  
**Dependensi**: database.js (saveDB, saveDBBatch), config.js (localItems, filteredItems)  
**Side Effects**: DOM updates, saveDB calls, feedback() audio/vibrate

---

### [scanner.js](js/scanner.js)
**Fungsi Publik Utama**:
- `openCameraScanner()` — Init Html5QrcodeScanner, open modal
- `onScanSuccess(decodedText, decodedResult)` — Handle QR success, call processScan()
- `closeCameraScanner()` — Stop scanner, clear modal

**Peran**: Wrapper untuk camera-based QR scanning; checks User Cari/Admin session before camera access  
**Caller**: HTML button onclick (Camera button), core.js indirect  
**Dependensi**: core.js (processScan), Html5QrcodeScanner library (external)  
**Side Effects**: DOM (camera modal), camera hardware access

---

### [excel.js](js/excel.js)
**Fungsi Publik Utama**:
- `handleImport(input)` — Read Excel dan consolidate per identitas; record lama hanya memperbarui qty dan mempertahankan lokasi, record baru tanpa lokasi; setelah upload bulk terotorisasi, rekonsiliasi ID lokal dengan server
- `exportData()` — Admin-only XLSX export with locations from `DB_MASTER.LOCATIONS` as comma-separated addresses and summed Opname counts per part
- `exportOffBsData()` — Export offBsSession ke XLSX
- `downloadNewParts()` — Download "PART BARU" list
- `backupJson()` — Backup localItems + offBsSession ke JSON file
- `restoreJson(input)` — Restore harga saja; lokasi dari JSON diabaikan

**Peran**: Data import/export; backup/restore utility  
**Caller**: HTML menu buttons (Import/Export)  
**Dependensi**: config.js (localItems), database.js (saveDB, db transaction), XLSX library (external)  
**Side Effects**: IndexedDB write, localStorage update untuk antrean/waktu upload DATA STOCK, file download, location.reload()

---

### [utils.js](js/utils.js)
**Fungsi Publik Utama**:
- `feedback(type)` — Play distinct scan/result tones, vibrate, and flash the scanner input state
- `playTone(freq, type, duration)` — Web Audio API tone generator
- `showToast(message)` — Display floating toast notification
- `toggleDarkMode()` — Switch light/dark theme
- Bottom navigation — Switch between workflow and settings tabs


**Peran**: UI utilities; feedback & styling helpers  
**Caller**: core.js (feedback), event handlers (toggleDarkMode), any scanner success  
**Dependensi**: Web Audio API, Vibration API, DOM manipulation  
**Side Effects**: DOM class toggle, audio play, localStorage setItem (darkMode)

---

### [style.css](css/style.css)
**Peran**: Styling utama; CSS variables untuk theme, layout responsive mobile-first  
**Features**: Dark mode support, PWA standalone styling, tab navigation, status indicators  
**Scope**: Semua element di index.html

---

### [code.gs](code.gs) — Google Apps Script Macro
**Fungsi Publik**:
- `doGet(e)` — Read-only GET endpoint untuk DB_MASTER/META; returns items as JSON
- `doPost(e)` — POST endpoint; verifikasi token Admin untuk semua aksi tulis, lalu handle sync/import
- `setupAdminPassword()` — Run from the bound Apps Script editor; requires the project manifest's `userinfo.email`, spreadsheet, container UI, and script storage OAuth scopes; creates hash+salt credentials, protects role/location sheets, and reports the failing setup stage in execution details
- `handleAdminLogin()` / `validateAdminSession()` / `revokeAdminSession()` — Kelola token sesi Admin
- `ensureDbMasterLocationProtection(sheet)` — Protect kolom G (lokasi fisik) dari edit langsung editor spreadsheet; akun eksekusi Apps Script dapat menulis lewat aplikasi (pemilik spreadsheet tetap mengikuti hak istimewa Google)
- `ensureMasterRevisionColumn()` / `getMasterRevisionConflicts()` — Maintain per-row revisions and reject stale snapshots before writes
- `normalizeOpnameCompletedMap()` / `mergeDataFast()` — Validate and sync `OPNAME_COMPLETED` in DB_MASTER column M
- `mergeDataFast(sheet, incomingItems, revisionColumnIndex)` — Apply queued Admin scans and return acknowledged revisions
- `mergeStockQuantities(sheet, incomingItems, revisionColumnIndex)` — Lock update; increment revisions and return canonical ID/revision mappings

**Peran**: Backend server logic; data persist ke Google Sheets; deduplication  
**Caller**: database.js (manual `downloadFromServer()` and `processSyncQueue()`)
**Sheets Used**:
- `DB_MASTER` — Master item data (id, partNo, desc, locType, techName, sysQty, locations membership JSON in column G, labelIssues JSON, opnameCounts JSON in column J, `REVISION` in column L, and `OPNAME_COMPLETED` JSON in column M)
- `BOX_REGISTRY` — Shared scanned box codes (`BOX_CODE`); batch append and confirmed mapping deletion run under ScriptLock, without rewriting DB_MASTER
- `LOG_SCAN` — Audit log (partNo, action, detail, timestamp)
- `TEMP_OFF_BS` — Off-balance-sheet staging (time, box, partNo, qty, docNo, qr, updated_at timestamp)
- `WMS_USER_ROLE` — Protected, hidden Admin password hash + salt (never plaintext)

**Actions Supported**:
- `sync` — Validate expected revisions under ScriptLock; return conflicts without writes when stale, otherwise merge and return new revisions
- `sync_off_bs` — Append off BS items, detect duplicates via (partNo_docNo)
- `bulk_import` — Merge hasil Excel ke DB_MASTER, increment revisions, preserve existing locations, and return canonical IDs/revisions
- `get_box_registry` / `save_box_registry` / `delete_box_registry` — Authenticated shared box registry reads, append-only batch saves, and mapping-only deletes
- `sync` — Terima lokasi dari alur scan/pindah aplikasi; tidak digunakan untuk impor Excel
- `DB_MASTER` column G — Protected from direct edits by spreadsheet editors; code locations are changed through scanned app workflows (spreadsheet owners retain Google owner privileges)
- `delete_off_bs` — Remove items from TEMP_OFF_BS by QR

**Side Effects**: Google Sheets data mutation, sheet operations

---

### [sw.js](sw.js) — Service Worker
**Strategi Caching**: Network-first dengan fallback ke cache  
**Cache Name**: `wms-cache-<app-version>` (versioned from version.json)
**Version Alignment**: `version.json.version` is passed to `sw.js?v=...`; keep the service-worker fallback release version aligned with it.
**Current Release**: `version.json` and the `sw.js` fallback are aligned at `1.5.27`; bump both for each cache-affecting release.

**Cached Assets** (on install):
- Local app shell: `index.html`, CSS, JavaScript, manifest, icons, `version.json`
- Best-effort CDN cache: Font Awesome, SheetJS, and html5-qrcode
- CDN cache failures do not block installation of the local app shell

**Cache Bypass** (never cached):
- `script.google.com/*` → Always fetch fresh (API calls)
- POST requests → Always fresh (sync operations)

**Cleanup**: Old cache versions auto-deleted on activate

**Peran**: Enable offline mode; instant page load  
**Caller**: Browser automatic; registered in main.js  
**Side Effects**: Cache storage, fetch interception

---

### [index.html](index.html) — UI Structure
**Navigation Tabs** (OFF BS and PACKING temporarily hidden and guarded):
1. **SIMPAN** — Penyimpanan (single-scan or multi-scan buffer mode)
2. **OPNAME** — Inventory check per box or rack level; rack view groups child boxes and defers comparison until all item locations are closed
3. **DATA** — Search & view all items
4. **SETTING** — Application settings
5. **OFF BS** — Temporarily disabled
6. **PACKING** — Temporarily disabled
- On mobile bottom navigation, OFF BS and PACKING stay hidden; SIMPAN, OPNAME, and DATA receive more width than SETTING.

**Key Modals**:
- Camera Scanner (Html5QrcodeScanner)
- Simpan Conflict (move vs split decision)
- Opname Conflict (location conflict resolution)
- Opname Over-Scan (confirm adding a scan above imported stock target)
- Active OPNAME panel has two columns: a large 30%-width box identity at left; at right, joined stats above actions
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
const API_URL = "(lihat js/config.js; URL deployment tidak diduplikasi di dokumentasi)";
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
  locations: {                 // Membership box/tingkat; bukan kuantitas
    "A-01": true,
    "B-B1": true,              // Part yang langsung berada di tingkat rak
    "B-B1-01": true            // Box turunan tingkat B-B1
  },
  opnameCounts: {              // Hasil hitung fisik positif per target box/rak; key bernilai 0 dihapus
    "A-01": 5,
    "B-10": 3
  },
  opnameCompleted: {           // Legacy cloud completion markers; ignored by current Opname status
    "B-B1": true
  },
  labelIssues: {               // Label quality issues
    DAMAGED: number,
    NO_LABEL: number
  },
  raw: object                  // Original Excel row
  revision: number             // Server-owned optimistic concurrency version
}
```

**localStorage Keys**:
- `wms_packing`: Packing session (JSON array)
- `wms_colly_list`: Colly definitions (JSON array)
- `wms_active_colly`: Active colly ID (string)
- `wms_off_bs`: Off BS session (JSON array)
- `darkMode`: Dark mode toggle (boolean string)

**Sync Queue (IndexedDB outbox + memory mirror)**:
```javascript
syncQueue: Item[]              // Mirror of outbox entries; item-keyed and survives refresh
outbox: Item[]                 // IndexedDB object store written atomically with items
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
**Service**: `API_URL` from `js/config.js` (deployment endpoint; not duplicated in docs)  
**Caller Modules**: database.js:
- `downloadFromServer()` — GET read-only cloud data; Admin can request manually and User refreshes automatically without clearing local-only records or pending queue
- `processSyncQueue()` — POST items & logs untuk sync (doPost:action=sync)
- `handleImport()` in excel.js — POST bulk import (doPost:action=bulk_import)
- `auth.js` — POST admin_login and attach Admin token to all write actions

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

**Sync Policy**:
- No cloud request runs automatically on startup, timer, or `online` event.
- The header sync button opens a dialog with separate manual upload and download actions.
- Upload removes acknowledged records from the pending queue but keeps inventory in IndexedDB and local scan/session data.
- Download is an upsert merge: local-only records and pending upload records are preserved; newer local stock/master fields win timestamp conflicts. Admin can apply Cloud locations after confirmation; User refresh applies Cloud locations automatically for non-pending records.

**Error Handling**:
- Network error → Keep queue in syncQueue for the next manual upload
- API error (400, 500) → Show error toast, log to console
- Offline (navigator.onLine === false) → Keep queue, show offline indicator; no automatic retry

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

**Box Pattern Detection** (`BOX_CODE_PATTERN` in config.js):
- Legacy box: `/^[A-Z][0-9]{0,2}-[0-9]{2,3}$/` (e.g., A-01, A2-01, K-999)
- New box: `/^[A-Z]-[A-Z][0-9]-[0-9]{2}$/` (e.g., A-A3-01)
- Buffer stock: `/^[A-Z0-9]+-[A-Z]-[A-Z][0-9]-[0-9]{2}$/` (e.g., BUFFER-E-A1-01); supported by client and server validation
- Shared BOX_REGISTRY accepts `X-XY-YY` (e.g. `A-A1-01`) or the same format after a prefix (e.g. `BUFFER-A-A1-01`); the registry manager groups prefixed codes under Buffer and filters both saved and draft lists by rack group
- Destructive Move/Split, Box-to-box, Multi-Scan, and Opname removal actions require explicit confirmation; buffer boxes and last-location removals show additional warnings
- OFF BS box: Must start with `RTF` (e.g., RTF-001, RTF-A05)

**Usage in Flows**:
- core.js:normalizeBoxCode() canonicalizes scan whitespace and Unicode dash variants before box detection; the strict box pattern remains the validity gate
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
**Usage**: Icon classes in HTML (fa-search, fa-camera, fa-cog, etc.)  
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
- Register in main.js: `navigator.serviceWorker.register('sw.js?v=' + version, { updateViaCache: 'none' })`
- Cache namespace: `wms-cache-<app-version>`; old cache namespaces are removed on activation

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

**Latest Improvements** (CURRENT SESSION):

**LOCATION & ROLE SAFEGUARDS**
- ✅ Startup Admin/User gate; User navigates only to read-only Cari and searches by text or camera QR.
- ✅ Admin password stored as salted hash; an 8-hour server session token is required for every write POST.
- ✅ Stock Excel import preserves locations/master metadata for existing parts; it updates qty plus server-owned sync timestamp, appends new parts without locations, and reconciles canonical server IDs locally.
- ✅ Spreadsheet column G is protected; legacy box codes remain valid move sources but are rejected as destinations.
- ✅ Removed unused OPNAME location move/split actions and made JSON restore ignore locations.
- ✅ SIMPAN mode controls sit outside options accordion; modes are exclusive and pending multi-scan buffer is confirmed/preserved on exit.
- ✅ OPNAME/SIMPAN hide zero-qty items; download conflicts use canonicalized locations and only ask when local data is not newer.
- ⚠️ Deployment required: run `setupAdminPassword()` in Apps Script, deploy updated `code.gs`, and verify protection under the deployment execution account.

**SMART CONFLICT DETECTION: SPLIT/MOVE Modal (2026-05-23 v2)**
- ✅ **Removed workflowMode toggle**: Deleted workflowMode variable and toggle UI
- ✅ **Implemented Smart Conflict Detection**:
  - When part already has location(s), show modal with SPLIT/MOVE options
  - SPLIT: Keep existing location, add new one (location array grows)
  - MOVE: Replace old location with new one (transfer operation)
- ✅ **New Functions**:
  - `showSimpanConflictModal(item, newBox)`: Display conflict modal with existing locations
  - Updated `executeSimpanAction(action)`: Handle SPLIT/MOVE without quantity logic
  - `closeSimpanConflictModal()`: Close modal and reset state
- ✅ **Updated processScan() SIMPAN Branch**:
  - If part has NO locations → Direct save (`locations[box] = true` membership)
  - If part HAS locations → Show conflict modal for user decision
- ✅ **Removed**:
  - `toggleWorkflowMode()` function
  - workflowMode localStorage initialization in main.js
  - workflowMode variable from config.js
  - Workflow mode checkbox from HTML (#chkWorkflowMode)
  - workflowModeIcon element from HTML
- ✅ **Kept for Reference**: Old `checkSimpanConflict()` function (not used, but kept as reference)
- **UI**: Modal shows: "Part X sudah ada di: [old locs], Target baru: [new box]" with PINDAH/SPLIT buttons
- **Impact**: Intelligent location handling - users can choose to add location (SPLIT) or transfer (MOVE)

**PREVIOUS: Location-Only Mode (2026-05-23 v1)**
- ✅ **Removed All Qty Tracking**: No progress badge (X/Y), no "+1" messages, no qty validation
- ✅ **Location-Only Workflow**: Scan part → Select & display detail panel → Scan box → Save location
- ✅ **No qty increment**: saveDB() records location only, qty always implicit

**Previous Session (2026-05-09):**

**REFACTOR: SIMPAN Tab SINGLE/MULTIPLE Mode (2026-05-09)**
- ✅ **Eliminated Buffer Accumulation**: Removed `useSimpanBuffer` logic and `simpanBuffer[]`
- ✅ **Introduced simpanMode Toggle**: New state variable `simpanMode: 'single' | 'multiple'`
- ✅ **New Multi-Scan Functions**: addToMultiScan, removeFromMultiScan, clearMultiScan, processMultiScan
- ✅ **Dual Display Panel**: singleModeDisplay (detail) vs multiModeDisplay (buffer list)
- ✅ **Removed Deprecated Functions**: Disabled useSimpanBuffer, activeDirectPart, simpanBuffer, targetBufferBox
- ✅ **Fixed syntax**: Removed duplicate getSimilarParts() declaration


- ✅ **Data Persistence on Refresh**: syncQueue & syncLogs now persisted to localStorage, survive page refresh
- ✅ Cloud sync is manual-only: no startup download, periodic upload, or online-event retry
- ✅ Header dialog provides separate Upload/Download actions; cloud download upserts and preserves local-only/pending/newer records
- ✅ **Qty Overflow Protection**: Added check in SIMPAN tab to prevent scanning more than sysQty (matches OFF BS logic)
- ✅ **Opname Count Flow**: Box selection displays all filtered stock items; every part QR increments X by one, X/Y compares session count to sysQty, and SELISIH/BELUM use that same X. SELESAI replaces per-box quantities with the counted result.
- ✅ **Multi-Scan Logic Fixed**: isMultiScan check in processScan() now routes correctly to processMultiBatchMove
- ✅ **Redundant Function Removed**: Obsolete processSimpanBuffer() deleted
- ✅ **Buffer Validation Added**: All buffers (multiBuffer, simpanBuffer, opnameBuffer) now validated as arrays

**Status**: 9 critical improvements implemented:
- ✅ Active Part Details Panel restore (2026-05-09)
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
