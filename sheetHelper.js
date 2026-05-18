// sheetHelper.js — Google Sheets config cache with auto-refresh
// Reads a 4-column sheet (Key, ชื่อการตั้งค่า, ค่าที่ตั้ง, คำอธิบาย) from columns A:D.
// Config value is read from column C (index 2).

const { google } = require("googleapis");
const path = require("path");
const cron = require("node-cron");

// ─── In-Memory Config Cache ────────────────────────────────────────────
let configCache = null;
let lastFetchedAt = null;

// ─── Google Sheets Auth (Service Account) ──────────────────────────────
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
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
  };

  configCache = config;
  lastFetchedAt = new Date();
  console.log(`[SheetHelper] ✅ Config loaded at ${lastFetchedAt.toISOString()}`);
  console.log(`[SheetHelper]    bot_status=${config.bot_status}, forward_mode=${config.forward_mode}`);
  console.log(`[SheetHelper]    good_keywords=[${config.good_keywords.join(", ")}]`);
  console.log(`[SheetHelper]    bad_keywords=[${config.bad_keywords.join(", ")}]`);

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
  sheetsClient = null; // Reset auth client too
  return fetchConfig();
}

/**
 * Start automatic refresh with node-cron.
 * Default: every 5 minutes.
 */
function startAutoRefresh(cronExpression = "*/5 * * * *") {
  cron.schedule(cronExpression, async () => {
    try {
      console.log("[SheetHelper] 🔄 Auto-refreshing config...");
      await fetchConfig();
    } catch (err) {
      console.error("[SheetHelper] ❌ Auto-refresh failed:", err.message);
    }
  });
  console.log(`[SheetHelper] ⏰ Auto-refresh scheduled: ${cronExpression}`);
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
};
