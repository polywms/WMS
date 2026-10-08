/**
 * Tujuan: Inisialisasi aplikasi WMS dan lifecycle PWA.
 * Caller: Browser melalui window.onload.
 * Dependensi: database.js (initDB), core.js (render dan state SIMPAN), Service Worker API.
 * Main Functions: registerServiceWorker(), checkForUpdates(), window.onload.
 * Side Effects: IndexedDB init, registrasi cache, wake lock, pembacaan waktu upload dari localStorage, dan sinkronisasi tampilan.
 */
let wakeLock = null;

// ===== VERSION CHECK & AUTO UPDATE =====
async function registerServiceWorker(version) {
    if (!('serviceWorker' in navigator)) return;

    try {
        const registration = await navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(version)}`, {
            updateViaCache: 'none'
        });
        await registration.update();
        return registration;
    } catch (error) {
        console.log('Service worker update skipped:', error);
    }
}

async function checkForUpdates() {
    try {
        const response = await fetch('./version.json?t=' + Date.now());
        if (!response.ok) return;
        
        const data = await response.json();
        await registerServiceWorker(data.version);
        const savedVersion = localStorage.getItem('appVersion');
        
        if (savedVersion && data.version !== savedVersion) {
            if (confirm('UPDATE TERSEDIA!\n\nReload aplikasi untuk versi terbaru?')) {
                localStorage.setItem('appVersion', data.version);
                
                window.location.reload();
            }
        } else if (!savedVersion) {
            localStorage.setItem('appVersion', data.version);
        }
    } catch (e) { 
        console.log('Version check skipped (offline)'); 
    }
}

async function requestWakeLock() {
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        console.log('Screen Wake Lock active');
        wakeLock.addEventListener('release', () => console.log('Screen Wake Lock released'));
    } catch (err) { console.log(`${err.name}, ${err.message}`); }
}

document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') await requestWakeLock();
});

document.addEventListener('click', (e) => {
    const t = e.target;
    const interactive = ['INPUT','BUTTON','SELECT','TEXTAREA','A','LABEL'];
    
    if (!interactive.includes(t.tagName) && !t.closest('button') && !t.closest('.modal')) {
        // Cek sedang di tab mana
        if (typeof currentTab !== 'undefined' && currentTab === 'data') {
            document.getElementById('cariInput').focus();
        } else {
            const mainInput = document.getElementById('mainInput');
            if(mainInput) mainInput.focus();
        }
    }
});

window.onload = async () => {
    await initDB();
    if(localStorage.getItem('darkMode') === 'true') document.body.classList.add('dark-mode');
    const lastStockUploadAt = localStorage.getItem('lastStockUploadAt');
    const lastStockUploadDate = lastStockUploadAt ? new Date(lastStockUploadAt) : null;
    const lastStockUploadElement = document.getElementById('lastStockUploadAt');
    if (lastStockUploadElement && lastStockUploadDate && !Number.isNaN(lastStockUploadDate.getTime())) {
        lastStockUploadElement.textContent = `Upload terakhir: ${lastStockUploadDate.toLocaleString('id-ID')}`;
    }
    requestWakeLock();
    document.getElementById('mainInput').focus();
    
    // Initialize favicon
    if(typeof updateFavicon === 'function') updateFavicon(false);
    
    
    // Initialize Simpan Buffer Mode toggle checkbox based on localStorage
    const chkSimpanBuffer = document.getElementById('chkSimpanBuffer');
    if (chkSimpanBuffer) {
        chkSimpanBuffer.checked = useSimpanBuffer;  // Should be true by default
        const bufferIcon = document.getElementById('bufferModeIcon');
        if (bufferIcon) {
            if (useSimpanBuffer) {
                bufferIcon.style.background = 'var(--active-color)';
                bufferIcon.style.borderColor = 'var(--active-color)';
                bufferIcon.style.color = 'white';
                bufferIcon.title = 'Mode Buffer: ON';
            } else {
                bufferIcon.style.background = 'white';
                bufferIcon.style.borderColor = '#cbd5e1';
                bufferIcon.style.color = 'var(--secondary)';
                bufferIcon.title = 'Mode Buffer: OFF (Direct Save)';
            }
        }
        // Ensure buffer panel visibility matches state
        const statusPanel = document.getElementById('simpanStatusPanel');
        if (statusPanel) {
            statusPanel.style.display = useSimpanBuffer ? 'block' : 'none';
        }
    }

    // Restore Multi-Scan toggle and panel from the persisted SIMPAN mode.
    const chkMultipleScan = document.getElementById('chkMultipleScan');
    const multipleScanIcon = document.getElementById('multipleScanIcon');
    const multiScanPanel = document.getElementById('multiScanPanel');
    const isMultipleScan = simpanMode === 'multiple';
    if (chkMultipleScan) chkMultipleScan.checked = isMultipleScan;
    if (multipleScanIcon) {
        multipleScanIcon.style.background = isMultipleScan ? 'var(--active-color)' : 'white';
        multipleScanIcon.style.borderColor = isMultipleScan ? 'var(--active-color)' : '#cbd5e1';
        multipleScanIcon.style.color = isMultipleScan ? 'white' : 'var(--secondary)';
        multipleScanIcon.title = isMultipleScan ? 'Mode: MULTI-SCAN' : 'Mode: SINGLE Scan';
    }
    if (multiScanPanel) multiScanPanel.style.display = isMultipleScan ? 'block' : 'none';
    if (isMultipleScan && typeof renderMultiScanList === 'function') renderMultiScanList();
    
    // Check for updates after 3 seconds
    setTimeout(checkForUpdates, 3000);
    
    const scrollBtn = document.getElementById('scrollTopBtn');
    const setupScroll = (id, callback) => {
        const el = document.getElementById(id);
        if(el) el.addEventListener('scroll', () => {
            if(el.scrollTop + el.clientHeight >= el.scrollHeight - 50) callback();
            if (el.scrollTop > 300) scrollBtn.style.display = 'flex';
            else scrollBtn.style.display = 'none';
        });
    };
    setupScroll('tab-opname', () => { renderLimit += 50; handleOpnameRender(false); });
    setupScroll('tab-simpan', () => { renderLimit += 50; renderSimpanList(false); });
    setupScroll('tab-data', () => { renderLimit += 50; renderDataList(false); });
};

// The version check registers the worker with a release-specific URL.
