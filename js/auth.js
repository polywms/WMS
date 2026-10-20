/*
 * Tujuan: Mengatur sesi Admin/User, tampilan sesuai role, refresh baca User, dan request API terotorisasi.
 * Caller: main.js, core.js, database.js, excel.js, dan event handler role di index.html.
 * Dependensi: config.js (API_URL), Apps Script role endpoint, dan localStorage.
 * Main Functions: authenticateAdmin(), chooseUserRole(), initializeRoleSession(), applyRoleUi() keeps the session exit icon-only, endRoleSession(), requireAdminAccess(), postWmsAction().
 * Side Effects: Membaca/menulis sesi lokal dan mengirim request autentikasi/API.
 */

const ADMIN_SESSION_KEY = 'wms_admin_session';
const USER_ROLE_KEY = 'wms_selected_role';
let currentRole = null;
let adminSession = null;

function readAdminSession() {
    try {
        const saved = JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY) || 'null');
        return saved && typeof saved.token === 'string' && Number(saved.expiresAt) > Date.now()
            ? saved
            : null;
    } catch (error) {
        console.error('Sesi Admin lokal tidak valid:', error);
        return null;
    }
}

function isAdminSessionActive() {
    return currentRole === 'admin'
        && adminSession
        && typeof adminSession.token === 'string'
        && Number(adminSession.expiresAt) > Date.now();
}

function requireAdminAccess(actionLabel = 'aksi ini') {
    if (isAdminSessionActive()) return true;
    showToast(`Sesi Admin tidak aktif. Login Admin diperlukan untuk ${actionLabel}.`);
    showRoleGate();
    return false;
}

async function postWmsAction(payload, adminRequired = true) {
    const requestPayload = { ...payload };
    if (adminRequired) {
        if (!requireAdminAccess('mengubah data cloud')) {
            throw new Error('Sesi Admin tidak aktif atau telah kedaluwarsa.');
        }
        requestPayload.authToken = adminSession.token;
    }
    return fetch(API_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(requestPayload)
    });
}

function showRoleGate() {
    currentRole = null;
    const gate = document.getElementById('roleGate');
    const roleChoices = document.getElementById('roleChoices');
    const adminForm = document.getElementById('adminLoginForm');
    const error = document.getElementById('adminLoginError');
    const password = document.getElementById('adminPassword');
    if (gate) gate.style.display = 'flex';
    if (roleChoices) roleChoices.style.display = 'block';
    if (adminForm) adminForm.style.display = 'none';
    if (error) error.textContent = '';
    if (password) password.value = '';
    applyRoleUi();
}

function openAdminLogin() {
    document.getElementById('roleChoices').style.display = 'none';
    document.getElementById('adminLoginForm').style.display = 'block';
    document.getElementById('adminPassword').focus();
}

function applyRoleUi() {
    const isUser = currentRole === 'user';
    document.body.classList.toggle('role-user', isUser);
    document.body.classList.toggle('role-admin', currentRole === 'admin');

    document.querySelectorAll('.bottom-nav .nav-item').forEach(button => {
        button.hidden = !currentRole || (isUser && button.dataset.tab !== 'data');
    });
    const dataTabButton = document.querySelector('.bottom-nav .nav-item[data-tab="data"] span');
    if (dataTabButton) dataTabButton.textContent = isUser ? 'CARI' : 'DATA';

    const roleButton = document.getElementById('roleSessionButton');
    if (roleButton) {
        roleButton.hidden = !currentRole;
        roleButton.innerHTML = `<i class="fas ${isUser ? 'fa-right-left' : 'fa-right-from-bracket'}" aria-hidden="true"></i>`;
        roleButton.title = isUser ? 'Ganti mode pengguna' : 'Keluar dari sesi Admin';
        roleButton.setAttribute('aria-label', isUser ? 'Ganti mode pengguna' : 'Keluar dari sesi Admin');
    }

    const adminOnly = document.querySelectorAll('[data-admin-only]');
    adminOnly.forEach(element => {
        element.hidden = currentRole !== 'admin';
    });
    document.body.classList.toggle('simpan-tab-active', currentRole === 'admin' && currentTab === 'simpan');
    const searchCamera = document.getElementById('dataCameraButton');
    if (searchCamera) searchCamera.hidden = false;
}

function chooseUserRole() {
    const bufferWasConfirmed = currentTab !== 'simpan' || multiScanBuffer.length === 0
        || confirm(`Buffer Multi-Scan berisi ${multiScanBuffer.length} part. Masuk ke mode Cari dan pertahankan buffer untuk Admin?`);
    if (!bufferWasConfirmed) return;
    currentRole = 'user';
    adminSession = null;
    localStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.setItem(USER_ROLE_KEY, 'user');
    applyRoleUi();
    document.getElementById('roleGate').style.display = 'none';
    switchTab('data', { bufferConfirmed: true });
    const search = document.getElementById('cariInput');
    if (search) search.focus();
    refreshUserDataInBackground();
}

async function authenticateAdmin() {
    const passwordInput = document.getElementById('adminPassword');
    const error = document.getElementById('adminLoginError');
    const password = passwordInput.value;
    if (!password) {
        error.textContent = 'Password wajib diisi.';
        return;
    }

    const submit = document.getElementById('adminLoginButton');
    submit.disabled = true;
    error.textContent = 'Memverifikasi...';
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'admin_login', password })
        });
        const result = await response.json();
        if (!response.ok || result.status !== 'success' || !result.sessionToken || !result.expiresAt) {
            throw new Error(result.message || 'Login Admin gagal.');
        }
        adminSession = { token: result.sessionToken, expiresAt: Number(result.expiresAt) };
        localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(adminSession));
        localStorage.removeItem(USER_ROLE_KEY);
        currentRole = 'admin';
        applyRoleUi();
        document.getElementById('roleGate').style.display = 'none';
        switchTab('simpan');
        document.getElementById('mainInput').focus();
    } catch (requestError) {
        error.textContent = requestError instanceof Error
            ? requestError.message
            : 'Login Admin gagal. Periksa koneksi lalu coba lagi.';
    } finally {
        submit.disabled = false;
    }
}

async function endRoleSession() {
    if (isAdminSessionActive()) {
        try {
            const response = await postWmsAction({ action: 'admin_logout' });
            const result = await response.json();
            if (!response.ok || result.status !== 'success') {
                throw new Error(result.message || 'Sesi server tidak dapat dicabut.');
            }
        } catch (error) {
            console.error('Pencabutan sesi Admin di server gagal:', error);
            showToast('Keluar lokal berhasil, tetapi token server mungkin masih aktif sampai kedaluwarsa.');
        }
    }
    adminSession = null;
    localStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.removeItem(USER_ROLE_KEY);
    showRoleGate();
}

function initializeRoleSession() {
    adminSession = readAdminSession();
    if (adminSession) {
        currentRole = 'admin';
        applyRoleUi();
        document.getElementById('roleGate').style.display = 'none';
        return;
    }
    localStorage.removeItem(ADMIN_SESSION_KEY);
    if (localStorage.getItem(USER_ROLE_KEY) === 'user') {
        currentRole = 'user';
        applyRoleUi();
        document.getElementById('roleGate').style.display = 'none';
        switchTab('data', { bufferConfirmed: true });
        return;
    }
    showRoleGate();
    applyRoleUi();
}

window.authenticateAdmin = authenticateAdmin;
window.chooseUserRole = chooseUserRole;
window.openAdminLogin = openAdminLogin;
window.endRoleSession = endRoleSession;
