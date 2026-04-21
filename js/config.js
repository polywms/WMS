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
        pattern: /^([^|]+)\|(\d+)\|([^|]*)\|(.+)$/,
        extract: (match) => ({ 
            partNo: match[1].trim(), 
            qty: parseInt(match[2]) || 1, 
            docNo: match[4].trim() 
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
let syncQueue = [];
let syncLogs = [];
let isSyncing = false;
let filteredItems = [];
let currentTab = 'simpan';
let opnameFilter = 'all'; 
let activeBoxFilter = null;
let renderLimit = 50;
let tempPart = null; 
let opnameConflictData = null; 
let simpanConflictData = null;
let isMultiScan = false;
let multiBuffer = []; 
let editId = null;
let filterNewOnly = false; 
let lastAction = null; 
let scanHistory = []; 
let lastOpnameScanId = null;
let offBsSession = JSON.parse(localStorage.getItem('wms_off_bs') || '[]');
let activeOffBsBox = null;