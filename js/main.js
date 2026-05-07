// js/main.js
let wakeLock = null;

// ===== VERSION CHECK & AUTO UPDATE =====
async function checkForUpdates() {
    try {
        const response = await fetch('./version.json?t=' + Date.now());
        if (!response.ok) return;
        
        const data = await response.json();
        const savedVersion = localStorage.getItem('appVersion');
        
        if (savedVersion && data.version !== savedVersion) {
            if (confirm('UPDATE TERSEDIA!\\n\\nReload aplikasi untuk versi terbaru?')) {
                localStorage.setItem('appVersion', data.version);
                
                // Notify SW to skip waiting
                if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
                    setTimeout(() => window.location.reload(), 500);
                } else {
                    window.location.reload();
                }
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
    requestWakeLock();
    document.getElementById('mainInput').focus();
    
    // Initialize favicon
    if(typeof updateFavicon === 'function') updateFavicon(false);
    
    // Initialize Workflow Mode toggle checkbox based on localStorage
    const chkWorkflowMode = document.getElementById('chkWorkflowMode');
    if (chkWorkflowMode) {
        chkWorkflowMode.checked = (workflowMode === 'pindah_split');
        const icon = document.getElementById('workflowModeIcon');
        if (icon) {
            if (workflowMode === 'pindah_split') {
                icon.style.background = 'var(--active-color)';
                icon.style.borderColor = 'var(--active-color)';
                icon.style.color = 'white';
                icon.title = 'Mode: Pindah/Split';
            } else {
                icon.style.background = 'white';
                icon.style.borderColor = '#cbd5e1';
                icon.style.color = 'var(--secondary)';
                icon.title = 'Mode: Penyimpanan';
            }
        }
    }
    
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
    setupScroll('tab-opname', () => { renderLimit += 50; handleOpnameRender(); });
    setupScroll('tab-simpan', () => { renderLimit += 50; renderSimpanList(false); });
    setupScroll('tab-data', () => { renderLimit += 50; renderDataList(false); });
};

// Daftarkan Service Worker untuk PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
        .then(registration => console.log('ServiceWorker sukses: ', registration.scope))
        .catch(err => console.log('ServiceWorker gagal: ', err));
    });
}
