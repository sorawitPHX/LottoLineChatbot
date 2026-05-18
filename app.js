// app.js — LINE Group Message Forwarder Bot (cPanel-compatible)
// Entry po : Express server with LINE Webhook + test endpoints.

require("dotenv").config();

const fs = require("fs");
const path = require("path");

// ─── Custom Logger for cPanel (Writes to passenger.log) ───────────────
const logStream = fs.createWriteStream(path.join(__dirname, "passenger.log"), { flags: "a" });
function logToFile(prefix, args) {
  const time = new Date().toISOString();
  const msg = args.map(a => (typeof a === "object" ? JSON.stringify(a) : a)).join(" ");
  logStream.write(`[${time}] ${prefix}: ${msg}\n`);
}

const originalLog = console.log;
console.log = function(...args) {
  logToFile("LOG", args);
  originalLog.apply(console, args);
};

const originalError = console.error;
console.error = function(...args) {
  logToFile("ERR", args);
  originalError.apply(console, args);
};

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.stack || err.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
// ──────────────────────────────────────────────────────────────────────

const express = require("express");
const crypto = require("crypto");
const { middleware: lineMiddleware } = require("@line/bot-sdk");

const sheetHelper = require("./sheetHelper");
const lineHelper = require("./lineHelper");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── LINE SDK Config ───────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// ─── App Configuration ────────────────────────────────────────────────
// Base URL for the server (used to construct public image proxy URLs)
// On cPanel, set BASE_URL in .env to your full public URL, e.g., https://bannasainamrod.ac.th/lottoapi
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// Automatically extract the path component from BASE_URL to support subfolder deployments
let BASE_PATH = "/";
try {
  const parsedUrl = new URL(BASE_URL);
  BASE_PATH = parsedUrl.pathname;
} catch (err) {
  console.error("[Config] ⚠️ Invalid BASE_URL, fallback to /");
}

// ═══════════════════════════════════════════════════════════════════════
// ROUTES (Grouped via express.Router)
// ═══════════════════════════════════════════════════════════════════════
const mainRouter = express.Router();

// ─── Health Check ──────────────────────────────────────────────────────
mainRouter.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "LottoLineChatbot",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Test: Google Sheets Config ────────────────────────────────────────
mainRouter.get("/test/sheets", async (req, res) => {
  try {
    const info = sheetHelper.getCacheInfo();
    if (info.loaded) {
      return res.json({
        status: "ok",
        message: "Config is loaded from cache",
        lastFetchedAt: info.lastFetchedAt,
        config: info.config,
      });
    }
    // Force fetch if not loaded
    const config = await sheetHelper.fetchConfig();
    res.json({
      status: "ok",
      message: "Config fetched fresh from Google Sheets",
      config,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// ─── Test: Force Reload Config ─────────────────────────────────────────
mainRouter.get("/test/reload", async (req, res) => {
  try {
    const config = await sheetHelper.reloadConfig();
    res.json({
      status: "ok",
      message: "Config reloaded successfully",
      config,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// ─── Test: LINE Cache Stats ────────────────────────────────────────────
mainRouter.get("/test/cache", (req, res) => {
  const stats = lineHelper.getCacheStats();
  const sheetInfo = sheetHelper.getCacheInfo();
  res.json({
    status: "ok",
    lineCacheStats: stats,
    sheetCache: {
      loaded: sheetInfo.loaded,
      lastFetchedAt: sheetInfo.lastFetchedAt,
    },
  });
});

// ─── Test: Bot Status Overview ─────────────────────────────────────────
mainRouter.get("/test/status", (req, res) => {
  const config = sheetHelper.getConfig();
  const stats = lineHelper.getCacheStats();
  res.json({
    status: "ok",
    botConfig: config || "NOT LOADED",
    lineCacheStats: stats,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

// ─── Image Proxy Endpoint ──────────────────────────────────────────────
// LINE image messages require publicly accessible HTTPS URLs.
// The LINE Content API (api-data.line.me) needs an Authorization header,
// so we proxy it through our own server to serve as a public URL.
mainRouter.get("/image/:messageId", async (req, res) => {
  const { messageId } = req.params;
  const { sig } = req.query;

  // Verify signature to prevent abuse
  const expectedSig = generateImageSignature(messageId);
  if (sig !== expectedSig) {
    return res.status(403).json({ error: "Invalid signature" });
  }

  try {
    const { buffer, contentType } = await lineHelper.getMessageContent(messageId);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400"); // cache 24h
    res.send(buffer);
  } catch (err) {
    console.error(`[ImageProxy] ❌ Failed to fetch image ${messageId}:`, err.message);
    res.status(500).json({ error: "Failed to fetch image" });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// LINE WEBHOOK
// ═══════════════════════════════════════════════════════════════════════
mainRouter.post("/webhook", lineMiddleware(lineConfig), async (req, res) => {
  // Immediately respond 200 OK to LINE Platform (avoid timeout)
  res.status(200).send("OK");

  // Process events in background
  const events = req.body.events || [];
  // console.log('Got event', events)
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("[Webhook] ❌ Unhandled error in event processing:", err.message);
    }
  }
});

// ─── Mount Router ──────────────────────────────────────────────────────
app.use("/", mainRouter);
if (BASE_PATH !== "/") {
  app.use(BASE_PATH, mainRouter);
}

// ═══════════════════════════════════════════════════════════════════════
// EVENT HANDLER — Core Logic Flow (Hierarchical Evaluation)
// ═══════════════════════════════════════════════════════════════════════
async function handleEvent(event) {
  // Only process message events
  if (event.type !== "message") return;

  const config = sheetHelper.getConfig();
  const messageType = event.message.type;
  const messageText = messageType === "text" ? event.message.text : "";
  const groupId = event.source.groupId || "";
  const userId = event.source.userId || "";
  const replyToken = event.replyToken;

  // ─── Phase 1: Pre-flight & Secret Commands ──────────────────────────

  if (messageType === "text") {
    // #getid — Debug command
    if (config && config.debug_mode === "เปิด" && messageText === "#getid") {
      await lineHelper.replyMessage(replyToken, [
        {
          type: "text",
          text: `📋 Group ID: ${groupId}\n👤 User ID: ${userId}`,
        },
      ]);
      // console.log(`Group ID: ${groupId}\nUser ID: ${userId}`)
      return; // TERMINATE
    }

    // #sys.reload — Clear RAM cache, fetch Google Sheets immediately
    if (messageText === "#sys.reload") {
      try {
        await sheetHelper.reloadConfig();
        await lineHelper.replyMessage(replyToken, [
          {
            type: "text",
            text: "✅ Config reloaded successfully!",
          },
        ]);
      } catch (err) {
        await lineHelper.replyMessage(replyToken, [
          {
            type: "text",
            text: `❌ Reload failed: ${err.message}`,
          },
        ]);
      }
      return; // TERMINATE
    }

    // #sys.status — Reply current config state from RAM
    if (messageText === "#sys.status") {
      const currentConfig = sheetHelper.getConfig();
      const cacheStats = lineHelper.getCacheStats();
      const statusText = currentConfig
        ? [
          `🤖 Bot Status: ${currentConfig.bot_status}`,
          `📡 Forward Mode: ${currentConfig.forward_mode}`,
          `🖼️ Forward Image: ${currentConfig.forward_image}`,
          `⏰ Time Limit: ${currentConfig.time_limit_status}`,
          `🕐 Time Range: ${currentConfig.time_start} - ${currentConfig.time_end}`,
          `🔧 Debug Mode: ${currentConfig.debug_mode}`,
          `✅ Good Keywords: ${currentConfig.good_keywords.join(", ") || "ไม่มี"}`,
          `❌ Bad Keywords: ${currentConfig.bad_keywords.join(", ") || "ไม่มี"}`,
          `📦 Group Cache: ${cacheStats.groupSummaryCache}`,
          `👥 Profile Cache: ${cacheStats.memberProfileCache}`,
        ].join("\n")
        : "⚠️ Config not loaded yet!";

      await lineHelper.replyMessage(replyToken, [
        { type: "text", text: statusText },
      ]);
      return; // TERMINATE
    }

    // #sys.ping — Simple heartbeat
    if (messageText === "#sys.ping") {
      await lineHelper.replyMessage(replyToken, [
        { type: "text", text: "Pong! 🏓" },
      ]);
      return; // TERMINATE
    }
  }

  // ─── Phase 2: Global Constraints ────────────────────────────────────

  // Config not loaded yet — DROP
  if (!config) {
    console.log("[Webhook] ⚠️ Config not loaded, dropping event.");
    return;
  }

  // Kill switch
  if (config.bot_status === "ปิด") {
    return; // DROP
  }

  // Anti-infinite loop: ignore messages from the destination group
  if (groupId === config.admin_group_id) {
    return; // DROP
  }

  // Time-based filtering
  if (config.time_limit_status === "เปิด") {
    if (!isWithinOperatingHours(config.time_start, config.time_end)) {
      console.log('[Webhook] ❌ Time limit is closed, dropping event.')
      return; // DROP
    }
  }

  // ─── Phase 3: Payload Evaluation (The Filter) ──────────────────────

  if (messageType === "image") {
    if (config.forward_image === "เปิด") {
      // PASS — Forward the image
      await enrichAndForward(event, config);
      return;
    }
    return; // DROP
  }

  if (messageType === "text") {
    if (config.forward_mode === "ดึงทั้งหมด") {
      // PASS — Forward all text messages
      await enrichAndForward(event, config);
      return;
    }

    if (config.forward_mode === "คัดกรอง") {
      // Check Blacklist FIRST (Highest Priority)
      if (matchesKeywords(messageText, config.bad_keywords)) {
        return; // DROP — Bad keyword matched
      }

      // Check Whitelist
      if (matchesKeywords(messageText, config.good_keywords)) {
        // PASS
        await enrichAndForward(event, config);
        return;
      }

      return; // DROP — No whitelist match
    }

    return; // DROP — Unknown forward_mode
  }

  // All other types (Stickers, Videos, etc.) — DROP
  return;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Data Enrichment & Execution
// ═══════════════════════════════════════════════════════════════════════
async function enrichAndForward(event, config) {
  const groupId = event.source.groupId || "";
  const userId = event.source.userId || "";
  const messageType = event.message.type;

  // Fetch group name & user display name (with cache)
  const [groupSummary, memberProfile] = await Promise.all([
    lineHelper.getGroupSummary(groupId),
    lineHelper.getGroupMemberProfile(groupId, userId),
  ]);

  const groupName = groupSummary.groupName;
  const displayName = memberProfile.displayName;

  if (messageType === "text") {
    const text = event.message.text;
    await lineHelper.pushMessage(config.admin_group_id, [
      {
        type: "text",
        text: `📌: ${groupName}\n👤: ${displayName}\n💬: ${text}`,
      },
    ]);
  } else if (messageType === "image") {
    const messageId = event.message.id;
    const sig = generateImageSignature(messageId);
    const imageUrl = `${BASE_URL}/image/${messageId}?sig=${sig}`;

    console.log(`[Webhook] 🖼️ Image proxy URL: ${imageUrl}`);

    // Step 1: Send text caption first (always works)
    await lineHelper.pushMessage(config.admin_group_id, [
      {
        type: "text",
        text: `📌 จากกลุ่ม: ${groupName}\n👤 ลูกค้า: ${displayName}\n🖼️ ส่งรูปภาพ`,
      },
    ]);

    // Step 2: Attempt to send the image separately
    try {
      await lineHelper.pushMessage(config.admin_group_id, [
        {
          type: "image",
          originalContentUrl: imageUrl,
          previewImageUrl: imageUrl,
        },
      ]);
    } catch (imgErr) {
      console.error(`[Webhook] ❌ Image push failed, URL: ${imageUrl}`, imgErr.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check if current time (Asia/Bangkok) is within operating hours.
 * Handles same-day ranges only (e.g., 08:00 - 22:00).
 */
function isWithinOperatingHours(startStr, endStr) {
  const now = new Date();
  // Convert to Bangkok timezone
  const bangkokTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" })
  );

  const currentMinutes = bangkokTime.getHours() * 60 + bangkokTime.getMinutes();

  const [startH, startM] = startStr.split(":").map(Number);
  const [endH, endM] = endStr.split(":").map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle overnight ranges (e.g., 22:00 - 06:00)
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  } else {
    // Overnight: valid if current >= start OR current <= end
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }
}

/**
 * Check if messageText contains any of the keywords.
 * Uses simple .includes() — NO Regex (per anti-pattern rules).
 */
function matchesKeywords(text, keywords) {
  if (!keywords || keywords.length === 0) return false;
  const lowerText = text.toLowerCase();
  return keywords.some((kw) => lowerText.includes(kw.toLowerCase()));
}

/**
 * Generate HMAC signature for image proxy URL to prevent abuse.
 * Uses LINE_CHANNEL_SECRET as the signing key.
 */
function generateImageSignature(messageId) {
  return crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(messageId)
    .digest("hex")
    .substring(0, 16); // Short signature is enough for this use case
}

// ═══════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════
async function startServer() {
  // 1. Initialize Google Sheets config cache + auto-refresh cron
  await sheetHelper.init();

  // 2. Start Express server
  app.listen(PORT, () => {
    console.log("═══════════════════════════════════════════════");
    console.log(`🚀 LottoLineChatbot is running on port ${PORT}`);
    console.log(`📌 Base Path: ${BASE_PATH}`);
    console.log(`📡 Webhook URL: ${BASE_URL}/webhook`);
    console.log(`🧪 Test Sheets: ${BASE_URL}/test/sheets`);
    console.log(`🔄 Test Reload: ${BASE_URL}/test/reload`);
    console.log(`📊 Test Cache:  ${BASE_URL}/test/cache`);
    console.log(`📋 Test Status: ${BASE_URL}/test/status`);
    console.log("═══════════════════════════════════════════════");
  });
}

startServer();
