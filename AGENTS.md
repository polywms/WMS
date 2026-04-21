# AGENTS.md - Personalized Instructions for WMS Magelang V6

## Quick Reference
- **Read first**: [SYSTEM_MAP.md](SYSTEM_MAP.md) — architectural overview, flow diagram, module map
- **Codebase**: Vanilla JS ES6+, PWA with offline support, no build step
- **Tech Stack**: IndexedDB, Google Sheets API, Html5QrcodeScanner, SheetJS
- **Entry Point**: `index.html` → `main.js` → `database.js:initDB()` → `core.js`

## Navigation Map
| Layer | Primary File | Key Functions |
|-------|--------------|----------------|
| **UI/Entry** | index.html | 5 tabs (SIMPAN, OPNAME, DATA, OFF BS, PACKING) |
| **Init** | main.js | window.onload, SW register, wake lock |
| **Business Logic** | core.js | processScan(), per-tab render functions |
| **Data/Sync** | database.js | saveDB(), processSyncQueue(), IndexedDB ops |
| **Config** | config.js | Global variables, constants, API_URL |
| **Utilities** | utils.js, scanner.js, excel.js | Feedback, QR scanning, import/export |

## Known Conventions & Patterns

### Naming & Structure
- **Tab functions**: `render*List()` (renderSimpanList), `handle*Render()` (handleOpnameRender), `set*Filter()`
- **Action functions**: `execute*Action()` (executeSimpanAction), `toggle*Mode()` (toggleMultiMode)
- **UI state**: stored in `config.js` globals (currentTab, filteredItems, multiBuffer, etc.)
- **Modal**: Always `document.getElementById('{name}Modal')` → check HTML for pattern
- **Window functions**: All public functions exported to `window.*` namespace for onclick handlers

### Data Flow Pattern
1. **Trigger**: Event handler (onclick, onkeydown) → calls business function
2. **Process**: Validate → Update state (localItems or localStorage)
3. **Persist**: Call `saveDB()` or `localStorage.setItem()`
4. **Sync**: (Async) `processSyncQueue()` POST to Google Sheets
5. **UI**: Call render function to refresh display, `feedback()` for user feedback

### OFF BS ↔ PACKING Workflow (CUT & PASTE)
**Normal Flow**:
1. Scan part in OFF BS tab → add to offBsSession (OFF BS +1)
2. Scan part in PACKING tab → remove from offBsSession (OFF BS -1), add to packingSession (PACKING +1)
3. Toast message shows: "✅ Dipindah dari OFF BS → Colly!"

**Reset Functions** (2026-04-21 Fix):
- `clearOffBsBox()` — Clear active OFF BS box (set to 'Belum Diset'), local only
- `clearOffBsSession()` — Reset all OFF BS session:
  - Clears local offBsSession array
  - Deletes synced items from Google Sheets (action: "delete_off_bs")
  - Requires confirmation
  - Toast: "✅ Sesi OFF BS direset (local + cloud)"

### API Response Pattern
Google Sheets API returns:
```json
{ "status": "success|error", "data": [Item[]], "duplicates": 0, "duplicateParts": [] }
```

### QR Format Parsing
- **Standard**: `PART_NO|QTY|???|DOC_NO` (pipe-separated)
- **SCL Format**: `SCL/ QTY PART_NO` (space-separated)
- **Box Pattern**: `/^[A-Z][0-9]{0,2}-[0-9]{2,3}$/` regex
- **OFF BS Box**: Must start with `RTF`

### Session Data Locations
- **Active part**: `tempPart` variable (not persisted)
- **Multi-scan buffer**: `multiBuffer` array + localStorage (wms_packing, wms_off_bs, wms_colly_list)
- **Active tab**: `currentTab` variable
- **Filters**: `filteredItems`, `opnameFilter`, `activeBoxFilter`

## Before Editing Code

**Trace the call chain** using this map:
```
HTML event → function in core.js → saveDB() in database.js → loadDataFromLocal() → renderXXX()
```

**Check these before change**:
1. Which tab(s) is this function used in?
2. Does it call saveDB()? If yes, confirm sync logic is correct
3. Does it modify `localItems` directly? If yes, call saveDB() after
4. Does it touch DOM? Confirm element IDs exist in index.html

**Before Submit**:
- If touching processScan(), processSyncQueue(), or saveDB() → test offline & online mode
- If modifying data schema → check Excel import consolidation logic
- If adding new fields to Item → check render functions & export logic

## Common Tasks & Patterns

### Add New Tab
1. Add button in header nav-tabs
2. Create `#tab-{id}` div in main-content-wrapper
3. In `core.js:switchTab()`, add case for new tab
4. Create `render{TabName}List()` function
5. In `processScan()`, add `if (currentTab === '{id}')` block with logic

### Add New QR Format (Easy Now!)
1. Add entry to `QR_PARSERS` in config.js:
```javascript
newFormat: {
    name: 'newFormat',
    pattern: /your-regex-here/,
    extract: (match) => ({ partNo, qty, docNo })
}
```
2. `parseQRCode()` in core.js automatically tries all patterns
3. No core.js changes needed!

### Add New Field to Item Schema
1. Define in `config.js` comment
2. Initialize in `excel.js:consolidatedExcel` loop
3. Add to `saveDB()` payload
4. Add export logic in `excel.js:exportData()`
5. Update SYSTEM_MAP.md Data Schema section

### Monitor Sync Queue Health
```javascript
// Check queue status
console.log({
    queueSize: syncQueue.length,
    logSize: syncLogs.length,
    maxSize: MAX_QUEUE_SIZE,
    maxBatch: MAX_SYNC_BATCH
});

// If warning: queue size > 400
if (syncQueue.length > 400) alert("⚠️ Queue accumulating!");
```

### Fix Sync Bug
1. Check `processSyncQueue()` in database.js (now with batching)
2. Verify API_URL and payload format
3. Check Google Sheets macro logs
4. Test offline mode (toggle airplane mode)
5. Manually trigger: `processSyncQueue()`

### Performance Issue (Slow Render)
1. Check `renderLimit` in config.js
2. Use `requestAnimationFrame()` for large DOM updates
3. Consider filtering before render
4. Check IndexedDB transaction not blocking
5. Monitor queue size (should be <500)

## Improvements Applied (2026-04-21)

**1. Batch Sync Processing**
- `MAX_SYNC_BATCH = 100` — Process 100 items per POST
- `MAX_QUEUE_SIZE = 500` — Prevent overflow crashes
- `saveDB()` now checks queue size before add
- `processSyncQueue()` loops in batches, reverts on error

**2. Auto SW Cache Update**
- `version.json` checked every load (with cache bypass)
- User gets update prompt after 3 sec if new version found
- `SKIP_WAITING` message triggers immediate reload
- Old cache versions auto-deleted

**3. Modular QR Parser**
- `QR_PARSERS` config in config.js (standard, scl2025, simple)
- `parseQRCode(rawCode)` tries all patterns
- Returns: `{ partNo, qty, docNo, parser: name }`
- PACKING & OFF BS tabs now use parser (easier to extend)

## Debugging Tips

**Console Tricks**:
```javascript
// Check local state
console.log({ localItems, syncQueue, syncLogs, currentTab, filteredItems });

// Check IndexedDB
db.transaction('items', 'readonly').objectStore('items').getAll().onsuccess = e => console.log(e.target.result);

// Check localStorage
console.log(JSON.parse(localStorage.getItem('wms_off_bs')));

// Test sync manually
processSyncQueue();

// Check sync UI
document.getElementById('syncStatus').innerText;
```

**Common Error Patterns**:
- "undefined is not a function" → Often `item` not found in `localItems`; check `filteredItems.find()`
- Render not updating → Call `renderXXX(true)` to reset, or check `currentTab` is correct
- Sync stuck at "🟡 Menunggu..." → Check `navigator.onLine`, Google Sheets API quota
- Camera not opening → Check permission denied, try `chrome://device-access` settings

## Scalability Notes

**Current Limits**:
- UI renders first 50 items, loads more on scroll (renderLimit)
- IndexedDB stores ~50MB max
- Sync batch size unlimited (risk OOM for 10K+ items)

**If Growing**:
- Implement batch sync (e.g., 100 items per POST)
- Add server-side deduplication (cloud-side logic)
- Consider migrating to real database (Firebase, Supabase) instead of Google Sheets
- Add pagination/infinite scroll on renderLimit

## Security Notes

**Current Posture**:
- No authentication; all data exposed if URL shared
- Google Sheets API macro exposed in source code
- IndexedDB unencrypted (local storage)

**For Production**:
- Add OAuth 2.0 login (Google Sign-In)
- Implement row-level security (user_id column in Google Sheets)
- Consider API key rotation mechanism
- Add audit logging (who scanned what, when)

---

**Last Updated**: 2026-04-21  
**Relevant Files**: SYSTEM_MAP.md, all files in `/js/`, `/css/`  
**Before AI Session**: Always read SYSTEM_MAP.md first to avoid blind spots
