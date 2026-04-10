// js/config.js
const DB_NAME = 'WMS_Stock_v10';
const API_URL = "https://script.google.com/macros/s/AKfycbxDQBLQEyIaNwQsA2Ubs4KDhFI5v7aNs4pfrs_e8MDmVGwj1zuwHWoCMiGuB27flOsS/exec";

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