/*
 * Tujuan: Utilitas UI, feedback visual, getaran, dan buzzer aplikasi.
 * Caller: core.js dan handler UI melalui fungsi feedback/playChime.
 * Dependensi: Web Audio API, Vibration API, DOM, dan localStorage.
 * Main Functions: feedback(), playTone(), playChime(), playBoxCompleteChime().
 * Side Effects: Memutar audio, menggetarkan perangkat, mengubah DOM, dan menulis mode gelap.
 */
const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
const audioCtx = AudioContextConstructor ? new AudioContextConstructor() : null;
const audioMasterGain = audioCtx ? audioCtx.createGain() : null;
const audioCompressor = audioCtx ? audioCtx.createDynamicsCompressor() : null;
let feedbackVisualTimer = null;
let audioUnavailableNotified = false;

if (audioCtx) {
    audioMasterGain.gain.value = 1.0;
    audioCompressor.threshold.value = -6;
    audioCompressor.knee.value = 6;
    audioCompressor.ratio.value = 12;
    audioCompressor.attack.value = 0.003;
    audioCompressor.release.value = 0.15;
    audioMasterGain.connect(audioCompressor);
    audioCompressor.connect(audioCtx.destination);
}

function feedback(type) {
    const body = document.body;
    const visualType = ({
        scan_normal: 'scan',
        scan_complete: 'success',
        scan_saved: 'success',
        scan_over: 'error'
    })[type] || type;
    const input = document.getElementById('mainInput');
    const visualClasses = ['scan', 'success', 'warning', 'error', 'info']
        .map(state => `scan-feedback-${state}`);

    if (input) {
        input.classList.remove(...visualClasses);
        input.classList.add(`scan-feedback-${visualType}`);
        clearTimeout(feedbackVisualTimer);
        feedbackVisualTimer = setTimeout(() => {
            input.classList.remove(`scan-feedback-${visualType}`);
        }, 500);
    }

    if(type === 'success') {
        body.classList.add('flash-success');
        setTimeout(() => body.classList.remove('flash-success'), 500);
        playTone(850, 'sine', 0.09);
        setTimeout(() => playTone(1150, 'sine', 0.12), 110);
        if(navigator.vibrate) navigator.vibrate(50); 
    } else if (type === 'error') {
        body.classList.add('flash-error');
        setTimeout(() => body.classList.remove('flash-error'), 500);
        playTone(220, 'sawtooth', 0.14);
        setTimeout(() => playTone(150, 'sawtooth', 0.2), 160);
        if(navigator.vibrate) navigator.vibrate([100, 50, 100]); 
    } else if (type === 'warning') {
        playTone(650, 'triangle', 0.09);
        setTimeout(() => playTone(520, 'triangle', 0.12), 130);
        if(navigator.vibrate) navigator.vibrate([40, 30, 40]); 
    } else if (type === 'scan') {
        playTone(1350, 'sine', 0.07);
    } else if (type === 'scan_normal') {
        playTone(1050, 'sine', 0.07);
        if(navigator.vibrate) navigator.vibrate(30);
    } else if (type === 'scan_complete') {
        playTone(850, 'sine', 0.09);
        setTimeout(() => playTone(1100, 'sine', 0.09), 110);
        setTimeout(() => playTone(1400, 'sine', 0.16), 220);
        if(navigator.vibrate) navigator.vibrate([50, 30, 50, 30, 50]);
    } else if (type === 'scan_over') {
        playTone(520, 'triangle', 0.12);
        setTimeout(() => playTone(260, 'sawtooth', 0.2), 150);
        if(navigator.vibrate) navigator.vibrate([100, 50, 100]);
    } else if (type === 'scan_saved') {
        playTone(600, 'sine', 0.08);
        setTimeout(() => playTone(850, 'sine', 0.08), 110);
        setTimeout(() => playTone(1100, 'sine', 0.08), 220);
        setTimeout(() => playTone(1400, 'sine', 0.18), 330);
        if(navigator.vibrate) navigator.vibrate([50, 20, 50, 20, 50]);
    } else if (type === 'info') {
        playTone(760, 'sine', 0.08);
    }
}

function notifyAudioUnavailable() {
    if (audioUnavailableNotified) return;
    audioUnavailableNotified = true;
    showToast('Suara feedback tidak aktif; periksa izin atau audio perangkat.');
}

function playTone(freq, type, duration) {
    if (!audioCtx) {
        notifyAudioUnavailable();
        return;
    }

    const scheduleTone = () => {
        const startTime = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.35, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
        osc.connect(gain);
        gain.connect(audioMasterGain);
        osc.start(startTime);
        osc.stop(startTime + duration);
    };

    if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(scheduleTone).catch(error => {
            console.warn('Audio feedback unavailable:', error);
            notifyAudioUnavailable();
        });
    } else {
        scheduleTone();
    }
}

function playChime() {
    playTone(880, 'sine', 0.1); 
    setTimeout(() => playTone(1320, 'sine', 0.15), 150); 
}

function playBoxCompleteChime() {
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
    t.innerHTML = m; 
    t.classList.add('show'); 
    setTimeout(() => t.classList.remove('show'), 3000); 
}

function toggleDarkMode() { 
    document.body.classList.toggle('dark-mode'); 
    localStorage.setItem('darkMode', document.body.classList.contains('dark-mode')); 
}

// ===== LOADING MODAL FUNCTIONS =====
function showLoading(text = "Memproses...", subtext = "") {
    const modal = document.getElementById('loadingModal');
    if(!modal) return;
    document.getElementById('loadingText').innerHTML = text;
    document.getElementById('loadingSubtext').innerHTML = subtext;
    modal.style.display = 'flex';
}

function hideLoading() {
    const modal = document.getElementById('loadingModal');
    if(!modal) return;
    modal.style.display = 'none';
}