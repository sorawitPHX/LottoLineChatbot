// app.js — LINE Group Message Forwarder Bot (cPanel-compatible)
// Entry point: Express server with LINE Webhook + test endpoints.

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
console.log = function (...args) {
  logToFile("LOG", args);
  originalLog.apply(console, args);
};

const originalError = console.error;
console.error = function (...args) {
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

// Image debounce: wait for more images from same user before sending
const IMAGE_DEBOUNCE_MS = parseInt(process.env.IMAGE_DEBOUNCE_MS, 10) || 1500;

// ─── Image Buffer (Debounce) ───────────────────────────────────────────
// Key: "groupId_userId"
// Value: { timer, imageUrls: [], groupId, userId, config }
const imageBuffer = new Map();

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

// GET /webhook — For browser verification (LINE uses POST, not GET)
mainRouter.get("/webhook", (req, res) => {
  res.json({
    status: "ok",
    message: "Webhook endpoint is active. LINE Platform uses POST to send events here.",
    method: "GET (browser test)",
    timestamp: new Date().toISOString(),
  });
});

// POST /webhook — Actual LINE webhook handler
mainRouter.post("/webhook", lineMiddleware(lineConfig), async (req, res) => {
  // Immediately respond 200 OK to LINE Platform (avoid timeout)
  res.status(200).send("OK");

  // Process events in background
  const events = req.body.events || [];
  // console.log('Got event', events)
  // console.log(`Size of arrays ${events.length}`)
  // console.log(events)
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

    // ─── Requirement 3: Admin Group Activate / Deactivate ────────────

    // cmd_activate_admin
    if (config && messageText === config.cmd_activate_admin) {
      // Rule 1: Must be in a group
      if (event.source.type !== "group") {
        await lineHelper.replyMessage(replyToken, [
          { type: "text", text: "❌ ไม่สามารถทำรายการได้ กรุณาพิมพ์คำสั่งนี้ในแชทกลุ่มเท่านั้น" },
        ]);
        return; // TERMINATE
      }

      // Rule 2: Activate this group as admin
      try {
        await sheetHelper.updateConfigValue("admin_group_id", groupId);
        await sheetHelper.reloadConfig();

        // Get group name for confirmation
        const groupSummary = await lineHelper.getGroupSummary(groupId);
        await lineHelper.replyMessage(replyToken, [
          { type: "text", text: `✅ ตั้งค่ากลุ่ม "${groupSummary.groupName}" เป็นแชทกลาง (Admin Group) สำเร็จแล้ว!` },
        ]);
      } catch (err) {
        await lineHelper.replyMessage(replyToken, [
          { type: "text", text: `❌ ตั้งค่าไม่สำเร็จ: ${err.message}` },
        ]);
      }
      return; // TERMINATE
    }

    // cmd_deactivate_admin
    if (config && messageText === config.cmd_deactivate_admin) {
      // Rule 1: Must be in a group
      if (event.source.type !== "group") {
        await lineHelper.replyMessage(replyToken, [
          { type: "text", text: "❌ ไม่สามารถทำรายการได้ กรุณาพิมพ์คำสั่งนี้ในแชทกลุ่มเท่านั้น" },
        ]);
        return; // TERMINATE
      }

      // Rule 3: Check if this group is actually the current admin group
      if (groupId !== config.admin_group_id) {
        await lineHelper.replyMessage(replyToken, [
          { type: "text", text: "❌ กลุ่มนี้ไม่ได้เป็นแชทกลางอยู่แล้ว" },
        ]);
        return; // TERMINATE
      }

      try {
        // Get group name before deactivating
        const groupSummary = await lineHelper.getGroupSummary(groupId);
        await sheetHelper.updateConfigValue("admin_group_id", "");
        await sheetHelper.reloadConfig();

        await lineHelper.replyMessage(replyToken, [
          { type: "text", text: `✅ ยกเลิก "${groupSummary.groupName}" เป็นแชทกลางสำเร็จแล้ว บอทจะหยุดส่งข้อความมาที่นี่` },
        ]);
      } catch (err) {
        await lineHelper.replyMessage(replyToken, [
          { type: "text", text: `❌ ยกเลิกไม่สำเร็จ: ${err.message}` },
        ]);
      }
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
      // PASS — Buffer the image (debounce for multi-image sends)
      const messageId = event.message.id;
      const sig = generateImageSignature(messageId);
      const imageUrl = `${BASE_URL}/image/${messageId}?sig=${sig}`;
      bufferImage(groupId, userId, imageUrl, config);
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
    // Requirement 1: Dynamic text formatting
    const text = event.message.text;
    const lines = [];
    if (config.show_text_group_name === "เปิด") lines.push(`📌: ${groupName}`);
    if (config.show_text_display_name === "เปิด") lines.push(`👤: ${displayName}`);
    lines.push(`💬:\n${text}`);

    await lineHelper.pushMessage(config.admin_group_id, [
      { type: "text", text: lines.join("\n") },
    ]);

  } else if (messageType === "image") {
    // Single image fallback (should not be reached due to buffer, but kept for safety)
    const messageId = event.message.id;
    const sig = generateImageSignature(messageId);
    const imageUrl = `${BASE_URL}/image/${messageId}?sig=${sig}`;
    await flushImageBuffer(groupId, userId, [imageUrl], config);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Image Debounce Buffer
// ═══════════════════════════════════════════════════════════════════════

/**
 * Buffer an incoming image. If more images arrive from the same user
 * within IMAGE_DEBOUNCE_MS, they are accumulated. When the timer fires,
 * all buffered images are flushed in a single batch.
 */
function bufferImage(groupId, userId, imageUrl, config) {
  const key = `${groupId}_${userId}`;
  const existing = imageBuffer.get(key);

  if (existing) {
    // More images from same user — accumulate and reset timer
    clearTimeout(existing.timer);
    existing.imageUrls.push(imageUrl);
    existing.timer = setTimeout(() => {
      const entry = imageBuffer.get(key);
      imageBuffer.delete(key);
      if (entry) {
        flushImageBuffer(entry.groupId, entry.userId, entry.imageUrls, entry.config)
          .catch(err => console.error("[ImageBuffer] ❌ Flush failed:", err.message));
      }
    }, IMAGE_DEBOUNCE_MS);
    console.log(`[ImageBuffer] ➕ Accumulated image for ${key} (total: ${existing.imageUrls.length})`);
  } else {
    // First image from this user — start new buffer
    const timer = setTimeout(() => {
      const entry = imageBuffer.get(key);
      imageBuffer.delete(key);
      if (entry) {
        flushImageBuffer(entry.groupId, entry.userId, entry.imageUrls, entry.config)
          .catch(err => console.error("[ImageBuffer] ❌ Flush failed:", err.message));
      }
    }, IMAGE_DEBOUNCE_MS);

    imageBuffer.set(key, {
      timer,
      imageUrls: [imageUrl],
      groupId,
      userId,
      config,
    });
    console.log(`[ImageBuffer] 📸 New buffer started for ${key}`);
  }
}

/**
 * Flush all buffered images for a user.
 * Chunks images into pushMessage calls respecting LINE's 5-object limit.
 *
 * If show_image_caption === "เปิด":
 *   - Chunk 1: 1 Text + up to 4 Images = 5 objects max
 *   - Chunk 2+: up to 5 Images each
 * If show_image_caption === "ปิด":
 *   - All chunks: up to 5 Images each
 */
async function flushImageBuffer(groupId, userId, imageUrls, config) {
  const totalImages = imageUrls.length;
  console.log(`[ImageBuffer] 🚀 Flushing ${totalImages} image(s) for ${groupId}_${userId}`);

  // Fetch group name & user display name (with cache)
  const [groupSummary, memberProfile] = await Promise.all([
    lineHelper.getGroupSummary(groupId),
    lineHelper.getGroupMemberProfile(groupId, userId),
  ]);

  const groupName = groupSummary.groupName;
  const displayName = memberProfile.displayName;

  // Build image message objects
  const imageObjects = imageUrls.map(url => ({
    type: "image",
    originalContentUrl: url,
    previewImageUrl: url,
  }));

  // Build chunks according to caption config
  const chunks = [];
  let startIndex = 0;

  if (config.show_image_caption === "เปิด") {
    // First chunk: 1 text caption + up to 4 images
    const captionLines = [];
    if (config.show_image_group_name === "เปิด") captionLines.push(`📌: ${groupName}`);
    if (config.show_image_display_name === "เปิด") captionLines.push(`👤: ${displayName}`);
    captionLines.push(`🖼️ ส่งรูปภาพ ${totalImages} รูป`);

    const firstBatchImages = imageObjects.slice(0, 4); // max 4 images in first chunk
    chunks.push([
      { type: "text", text: captionLines.join("\n") },
      ...firstBatchImages,
    ]);
    startIndex = 4;
  }

  // Remaining chunks: up to 5 images each (no caption)
  for (let i = startIndex; i < imageObjects.length; i += 5) {
    chunks.push(imageObjects.slice(i, i + 5));
  }

  // Send each chunk as a separate pushMessage
  for (let i = 0; i < chunks.length; i++) {
    try {
      await lineHelper.pushMessage(config.admin_group_id, chunks[i]);
      console.log(`[ImageBuffer] ✅ Chunk ${i + 1}/${chunks.length} sent (${chunks[i].length} objects)`);
    } catch (err) {
      console.error(`[ImageBuffer] ❌ Chunk ${i + 1}/${chunks.length} failed:`, err.message);
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
