/*
 * Tujuan: Membuka kamera QR dan meneruskan hasil scan ke alur aplikasi.
 * Caller: Tombol kamera pada tab Cari dan kontrol scanner Admin.
 * Dependensi: Html5QrcodeScanner, auth.js, dan processScan() di core.js.
 * Main Functions: openCameraScanner(), onScanSuccess(), closeCameraScanner().
 * Side Effects: Meminta akses kamera dan mengubah tampilan modal scanner.
 */
let html5QrcodeScanner = null;

function openCameraScanner() {
    if (!currentRole) {
        showRoleGate();
        return;
    }
    if (currentRole === 'admin' && !requireAdminAccess('membuka kamera')) return;
    if (currentRole === 'user' && currentTab !== 'data') {
        showToast('Mode User hanya dapat mencari lokasi.');
        return;
    }
    document.getElementById('cameraModal').style.display = 'flex';
    html5QrcodeScanner = new Html5QrcodeScanner(
        "reader", 
        { fps: 10, qrbox: {width: 250, height: 250}, aspectRatio: 1.0 }, 
        false
    );
    html5QrcodeScanner.render(onScanSuccess, onScanError);
}

function onScanSuccess(decodedText, decodedResult) {
    closeCameraScanner();
    processScan(decodedText); // Memanggil core.js
}

function onScanError(errorMessage) {
    // Abaikan error ini
}

function closeCameraScanner() {
    document.getElementById('cameraModal').style.display = 'none';
    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear().catch(err => console.error("Gagal mematikan kamera", err));
        html5QrcodeScanner = null;
    }
    document.getElementById('mainInput').focus();
}