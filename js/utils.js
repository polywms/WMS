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
    } else if (type === 'scan_normal') {
        // Beep standar untuk scan normal (qty masih kurang)
        playTone(1200, 'sine', 0.05);
        if(navigator.vibrate) navigator.vibrate(30);
    } else if (type === 'scan_complete') {
        // Nada berurutan "Ding ding ting" untuk scan komplit (sesuai target)
        playTone(800, 'sine', 0.1);
        setTimeout(() => playTone(1000, 'sine', 0.1), 120);
        setTimeout(() => playTone(1200, 'sine', 0.15), 240);
        if(navigator.vibrate) navigator.vibrate([50, 30, 50, 30, 50]);
    } else if (type === 'scan_over') {
        // Nada error/harsh yang panjang dan jelas (qty berlebih)
        playTone(150, 'sawtooth', 0.3);
        if(navigator.vibrate) navigator.vibrate([100, 50, 100]);
    } else if (type === 'scan_saved') {
        // 4 nada bertingkat (ascending) untuk kesan "Sukses/Tersimpan" yang memuaskan
        // Nada 1 (Dasar): 600Hz, 0.1s, 0ms delay
        playTone(600, 'sine', 0.1);
        // Nada 2 (Naik): 800Hz, 0.1s, 100ms delay
        setTimeout(() => playTone(800, 'sine', 0.1), 100);
        // Nada 3 (Naik): 1000Hz, 0.1s, 200ms delay
        setTimeout(() => playTone(1000, 'sine', 0.1), 200);
        // Nada 4 (Puncak/Panjang): 1300Hz, 0.8s, 300ms delay
        setTimeout(() => playTone(1300, 'sine', 0.8), 300);
        if(navigator.vibrate) navigator.vibrate([50, 20, 50, 20, 50]);
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