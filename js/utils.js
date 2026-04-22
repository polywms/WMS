// js/utils.js
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function feedback(type) {
    const body = document.body;
    if(type === 'success') {
        body.classList.add('flash-success');
        setTimeout(() => body.classList.remove('flash-success'), 500);
        playTone(800, 'sine', 0.1);
        if(navigator.vibrate) navigator.vibrate(50); 
    } else if (type === 'error') {
        body.classList.add('flash-error');
        setTimeout(() => body.classList.remove('flash-error'), 500);
        playTone(150, 'sawtooth', 0.3);
        if(navigator.vibrate) navigator.vibrate([100, 50, 100]); 
    } else if (type === 'warning') {
        // Double beep untuk warning konflik (tinggi, cepat, tidak menakutkan)
        playTone(1000, 'sine', 0.08);
        setTimeout(() => playTone(1000, 'sine', 0.08), 120);
        if(navigator.vibrate) navigator.vibrate([40, 30, 40]); 
    } else if (type === 'scan') {
        playTone(1200, 'sine', 0.05);
    }
}

function playTone(freq, type, duration) {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
}

function playChime() {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    playTone(880, 'sine', 0.1); 
    setTimeout(() => playTone(1320, 'sine', 0.15), 150); 
}

function playBoxCompleteChime() {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    playTone(880, 'sine', 0.1);  
    setTimeout(() => playTone(1108, 'sine', 0.1), 150); 
    setTimeout(() => playTone(1320, 'sine', 0.3), 300); 
}

function setStatus(msg) {
    document.getElementById('scanStatusText').innerText = msg;
}

function scrollToTop() {
    const activeEl = document.querySelector('.tab-content.active');
    if(activeEl) activeEl.scrollTo({ top: 0, behavior: 'smooth' });
}

function showToast(m) { 
    const t = document.getElementById('toast'); 
    t.innerText = m; 
    t.classList.add('show'); 
    setTimeout(() => t.classList.remove('show'), 3000); 
}

function toggleMenu() { 
    const drawer = document.getElementById('sidebarDrawer');
    const overlay = document.getElementById('sidebarOverlay');
    
    if(drawer && overlay) {
        drawer.classList.toggle('active');
        overlay.classList.toggle('active');
    }
}

function toggleDarkMode() { 
    document.body.classList.toggle('dark-mode'); 
    localStorage.setItem('darkMode', document.body.classList.contains('dark-mode')); 
}

// ===== LOADING MODAL FUNCTIONS =====
function showLoading(text = "Memproses...", subtext = "") {
    const modal = document.getElementById('loadingModal');
    if(!modal) return;
    document.getElementById('loadingText').innerText = text;
    document.getElementById('loadingSubtext').innerText = subtext;
    modal.style.display = 'flex';
}

function hideLoading() {
    const modal = document.getElementById('loadingModal');
    if(!modal) return;
    modal.style.display = 'none';
}