// sheetHelper.js — Google Sheets config cache with auto-refresh
// Reads a 4-column sheet (Key, ชื่อการตั้งค่า, ค่าที่ตั้ง, คำอธิบาย) from columns A:D.
// Config value is read from column C (index 2).

const { google } = require("googleapis");
const path = require("path");

// ─── In-Memory Config Cache ────────────────────────────────────────────
let configCache = null;
let lastFetchedAt = null;
let cachedRows = null; // raw rows for row-index lookup when writing

// ─── Google Sheets Auth (Service Account) ──────────────────────────────
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service-account.json");

let sheetsClient = null;

/**
 * Initialise the Google Sheets API client (lazy singleton).
 */
async function getClient() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: SCOPES,
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/**
 * Fetch config from Google Sheets and parse into a structured object.
 * Sheet has 4 columns: Key (A), ชื่อการตั้งค่า (B), ค่าที่ตั้ง (C), คำอธิบาย (D).
 * Config value is read from column C (index 2).
 */
async function fetchConfig() {
  const sheets = await getClient();

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const range = process.env.GOOGLE_SHEET_RANGE || "ตั้งค่า!A:D";

  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEET_ID is not set in .env");
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = res.data.values;
  if (!rows || rows.length === 0) {
    throw new Error("Google Sheets returned empty data");
  }

  // Store raw rows for row-index lookup when writing
  cachedRows = rows;

  // Skip header row (row 0), parse key (col A) and value (col C)
  const raw = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const key = (row[0] || "").trim();   // Column A: key
    const value = (row[2] || "").trim(); // Column C: ค่าที่ตั้ง
    if (key) raw[key] = value;
  }

  // Build structured config
  const config = {
    admin_group_id: raw.admin_group_id || "",
    debug_mode: raw.debug_mode || "ปิด",
    bot_status: raw.bot_status || "ปิด",
    time_limit_status: raw.time_limit_status || "ปิด",
    time_start: raw.time_start || "00:00",
    time_end: raw.time_end || "23:59",
    forward_image: raw.forward_image || "ปิด",
    forward_mode: raw.forward_mode || "คัดกรอง",
    good_keywords: parseArray(raw.good_keywords),
    bad_keywords: parseArray(raw.bad_keywords),

    // Requirement 1: Dynamic text formatting
    show_text_group_name: raw.show_text_group_name || "เปิด",
    show_text_display_name: raw.show_text_display_name || "เปิด",

    // Requirement 2: Dynamic image formatting
    show_image_caption: raw.show_image_caption || "เปิด",
    show_image_group_name: raw.show_image_group_name || "เปิด",
    show_image_display_name: raw.show_image_display_name || "เปิด",

    // Requirement 3: Admin group commands
    cmd_activate_admin: raw.cmd_activate_admin || "#admin.activate",
    cmd_deactivate_admin: raw.cmd_deactivate_admin || "#admin.deactivate",
  };

  configCache = config;
  lastFetchedAt = new Date();

  return config;
}

/**
 * Parse a comma-separated string into a trimmed array.
 */
function parseArray(str) {
  if (!str) return [];
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Get the cached config. Returns null if not loaded yet.
 */
function getConfig() {
  return configCache;
}

/**
 * Get metadata about the cache state.
 */
function getCacheInfo() {
  return {
    loaded: configCache !== null,
    lastFetchedAt,
    config: configCache,
  };
}

/**
 * Force-reload config from Google Sheets (used by #sys.reload).
 */
async function reloadConfig() {
  configCache = null;
  lastFetchedAt = null;
  cachedRows = null;
  sheetsClient = null; // Reset auth client too
  return fetchConfig();
}

/**
 * Update a single config value in Google Sheets by key.
 * Finds the row where column A matches the key, then writes newValue to column C.
 * @param {string} key - The config key in column A (e.g., "admin_group_id")
 * @param {string} newValue - The new value to write to column C
 */
async function updateConfigValue(key, newValue) {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEET_ID is not set in .env");
  }

  // Ensure we have rows data to find the row index
  if (!cachedRows) {
    await fetchConfig();
  }

  // Find row index (1-based in Sheets, row 0 = header)
  let targetRowIndex = -1;
  for (let i = 1; i < cachedRows.length; i++) {
    const rowKey = (cachedRows[i][0] || "").trim();
    if (rowKey === key) {
      targetRowIndex = i + 1; // Sheets is 1-based
      break;
    }
  }

  if (targetRowIndex === -1) {
    throw new Error(`Key "${key}" not found in Google Sheets`);
  }

  // Extract sheet name from GOOGLE_SHEET_RANGE (e.g., "ตั้งค่า!A:D" → "ตั้งค่า")
  const fullRange = process.env.GOOGLE_SHEET_RANGE || "ตั้งค่า!A:D";
  const sheetName = fullRange.split("!")[0];

  // Write to column C of the target row
  const updateRange = `${sheetName}!C${targetRowIndex}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: updateRange,
    valueInputOption: "RAW",
    requestBody: {
      values: [[newValue]],
    },
  });

  console.log(`[SheetHelper] ✅ Updated key "${key}" to "${newValue}" at ${updateRange}`);
}

/**
 * Start automatic refresh using setInterval.
 * Interval is read from env REFRESH_INTERVAL_SEC (default: 300 = 5 minutes).
 * Supports second-level granularity.
 */
function startAutoRefresh() {
  const intervalSec = parseInt(process.env.REFRESH_INTERVAL_SEC, 10) || 300;
  const intervalMs = intervalSec * 1000;

  setInterval(async () => {
    try {
      // console.log("[SheetHelper] 🔄 Auto-refreshing config...");
      await fetchConfig();
    } catch (err) {
      console.error("[SheetHelper] ❌ Auto-refresh failed:", err.message);
    }
  }, intervalMs);

  console.log(`[SheetHelper] ⏰ Auto-refresh scheduled: every ${intervalSec} seconds`);
}

/**
 * Initialise: fetch config on startup + start cron.
 */
async function init() {
  try {
    await fetchConfig();
  } catch (err) {
    console.error("[SheetHelper] ❌ Initial config fetch failed:", err.message);
    console.error("[SheetHelper]    Bot will run with NO config until next refresh.");
  }
  startAutoRefresh();
}

module.exports = {
  init,
  getConfig,
  getCacheInfo,
  reloadConfig,
  fetchConfig,
  updateConfigValue,
};
