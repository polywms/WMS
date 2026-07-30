/**
 * ========================================
 * CONFIG - WMS Magelang V6
 * ========================================
 * 
 * Tujuan: Global config, constants, state variables, dan QR parser patterns
 * Caller: Semua modules (core.js, database.js, main.js, etc.)
 * 
 * Global State Variables (persisted ke localStorage):
 * - simpanMode: 'single' | 'multiple' — Toggle SINGLE vs MULTIPLE scan mode di SIMPAN tab
 * - multiScanBuffer: Array<{item, scannedTime}> — Parts yang akan discan bersama-sama
 * - currentTab: String — Active tab ID (simpan, opname, data, off-bs, packing)
 * - filteredItems: Array<Item> — Filtered items list untuk render
 * 
 * QR Parser Config:
 * - QR_PARSERS: Object dengan pattern & extract function per format
 * - Supported formats: standard (baru), sclMGL (lama), scl2025 (legacy), simple (fallback)
 * - Priority: standard → sclMGL → scl2025 → simple (first match wins)
 * 
 * Side Effects:
 * - localStorage read/write untuk persisten state
 * - Config accessed globally dari semua js files
 * ========================================
 */

// js/config.js
const DB_NAME = 'WMS_Stock_v10';
const API_URL = "https://script.google.com/macros/s/AKfycbxDQBLQEyIaNwQsA2Ubs4KDhFI5v7aNs4pfrs_e8MDmVGwj1zuwHWoCMiGuB27flOsS/exec";

// ===== QUEUE & SYNC CONFIG =====
const MAX_SYNC_BATCH = 100;      // Max items per sync POST
const MAX_QUEUE_SIZE = 500;      // Prevent queue overflow
const AUTO_SYNC_INTERVAL = 30000; // Auto-sync every 30 seconds (milliseconds)
let lastSyncTime = 0;
let lastCloudSyncTime = localStorage.getItem('lastCloudSyncTime') ? parseInt(localStorage.getItem('lastCloudSyncTime')) : 0;
let autoSyncTimer = null;

// ===== QR PARSER CONFIG =====
const QR_PARSERS = {
    standard: {
        name: 'standard',
        pattern: /^([^|]+)\|(\d+)\|([^|]*)\|([^|]+)/,
        extract: (match) => ({ 
            partNo: match[1].trim(), 
            qty: parseInt(match[2]) || 1, 
            docNo: match[4].trim() 
        })
    },
    sclMGL: {
        name: 'sclMGL (format lama)',
        pattern: /^([A-Z0-9\/\-]+)\s+(\d+)\s+(\S+)\s+(\S+)$/,
        extract: (match) => ({
            docNo: match[1].trim(),      // Case number: SCL/MGL/25/12/17/010
            qty: parseInt(match[2]) || 1, // Qty: 1
            // match[3] = Unit type (PS-PLD43BUG5959) - diabaikan
            partNo: match[4].trim()      // Part number: XV-033284-00A
        })
    },
    scl2025: {
        name: 'scl2025',
        pattern: /^SCL\/\s+(\d+)\s+(.+)$/,
        extract: (match) => ({ 
            docNo: 'SCL', 
            qty: parseInt(match[1]) || 1, 
            partNo: match[2].trim() 
        })
    },
    pipeThree: {
        name: 'pipeThree (format lama 3-pipe)',
        pattern: /^([^|]+)\|/,
        extract: (match) => ({
            partNo: match[1].trim().replace(/\s+/g, ''),  // Hapus semua spasi, hanya part number
            docNo: 'AUTO',
            qty: 1
        })
    },
    simple: {
        name: 'simple',
        pattern: /^(.+)$/,
        extract: (match) => ({ 
            partNo: match[1].trim(), 
            qty: 1, 
            docNo: 'AUTO' 
        })
    }
};

let db = null;
let localItems = [];
// Persist syncQueue & syncLogs to localStorage to survive refresh
let syncQueue = JSON.parse(localStorage.getItem('wms_syncQueue')) || [];
let syncLogs = JSON.parse(localStorage.getItem('wms_syncLogs')) || [];
let isSyncing = false;
let filteredItems = [];
let currentTab = 'simpan';
let opnameFilter = 'all'; 
let activeBoxFilter = null;
let renderLimit = 50;
let tempPart = null; 
let opnameConflictData = null; 
let simpanConflictData = null;
let targetBufferBox = null;  // Temporary target box for conflict detection (replaces isMultiScan)
let multiBuffer = []; 
let simpanBuffer = []; // Buffer untuk SIMPAN tab (accumulate qty saat scan part)
let simpanBufferBox = null; // Target box untuk simpanBuffer
let editId = null;
let filterNewOnly = false; 
let lastAction = null; 
let scanHistory = []; 
let scanHistoryLog = []; // History log untuk display (Part >> Box)
let lastOpnameScanId = null;
let offBsSession = JSON.parse(localStorage.getItem('wms_off_bs') || '[]');
let activeOffBsBox = null;
let boxToBoxModeActive = false;
let boxToBoxSourceBox = null;
let boxToBoxPending = null;

// ===== SIMPAN SINGLE vs MULTIPLE MODE (NEW) =====
let simpanMode = localStorage.getItem('wms_simpanMode') || 'single'; // 'single' atau 'multiple'
let multiScanBuffer = []; // Array untuk multiple mode: [{item, scannedTime}, ...]

// ===== OPNAME BUFFER (Cashier Mode) =====
let opnameBuffer = []; // Array of {item, qty} untuk accumulate parts
let opnameBufferBox = null; // Target box untuk finalize opname