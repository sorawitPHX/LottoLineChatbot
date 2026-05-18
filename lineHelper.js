// lineHelper.js — LINE API helpers with aggressive in-memory caching
// Prevents HTTP 429 rate-limit errors by caching group/profile data.

const { Client } = require("@line/bot-sdk");
const https = require("https");

// ─── LINE Client ───────────────────────────────────────────────────────
let client = null;

function getClient() {
  if (client) return client;
  client = new Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  });
  return client;
}

// ─── In-Memory Caches (TTL-based) ─────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cache structure: Map<key, { data, expiresAt }>
const groupSummaryCache = new Map();
const memberProfileCache = new Map();

/**
 * Get a value from cache if not expired.
 */
function getCached(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Set a value in cache with TTL.
 */
function setCache(cache, key, data) {
  cache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ─── LINE API Wrappers ────────────────────────────────────────────────

/**
 * Get group summary (name, pictureUrl, etc.) with caching.
 * @param {string} groupId
 * @returns {Promise<{groupName: string}>}
 */
async function getGroupSummary(groupId) {
  // Check cache first
  const cached = getCached(groupSummaryCache, groupId);
  if (cached) return cached;

  try {
    const lineClient = getClient();
    const summary = await lineClient.getGroupSummary(groupId);
    const result = {
      groupName: summary.groupName || "ไม่ทราบชื่อกลุ่ม",
    };
    setCache(groupSummaryCache, groupId, result);
    return result;
  } catch (err) {
    console.error(`[LineHelper] ❌ getGroupSummary(${groupId}) failed:`, err.message);
    return { groupName: "ไม่ทราบชื่อกลุ่ม" };
  }
}

/**
 * Get group member profile (displayName, etc.) with caching.
 * Falls back to "ไม่ทราบชื่อ" if the API call fails (e.g., user blocked bot).
 * @param {string} groupId
 * @param {string} userId
 * @returns {Promise<{displayName: string}>}
 */
async function getGroupMemberProfile(groupId, userId) {
  const cacheKey = `${groupId}:${userId}`;

  // Check cache first
  const cached = getCached(memberProfileCache, cacheKey);
  if (cached) return cached;

  try {
    const lineClient = getClient();
    const profile = await lineClient.getGroupMemberProfile(groupId, userId);
    const result = {
      displayName: profile.displayName || "ไม่ทราบชื่อ",
    };
    setCache(memberProfileCache, cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[LineHelper] ❌ getGroupMemberProfile(${groupId}, ${userId}) failed:`, err.message);
    // Mandatory fallback — DO NOT crash
    return { displayName: "ไม่ทราบชื่อ" };
  }
}

/**
 * Push a message to the destination group.
 * @param {string} to - Target group ID
 * @param {Array} messages - LINE message objects
 */
async function pushMessage(to, messages) {
  try {
    const lineClient = getClient();
    await lineClient.pushMessage(to, messages);
    console.log(`[LineHelper] ✅ Message pushed to ${to}`);
  } catch (err) {
    console.error(`[LineHelper] ❌ pushMessage(${to}) failed:`, err.message);
    // Log the full LINE API error response for debugging
    if (err.originalError && err.originalError.response) {
      console.error(`[LineHelper]    Status: ${err.originalError.response.status}`);
      console.error(`[LineHelper]    Body:`, JSON.stringify(err.originalError.response.data));
    }
    if (err.statusCode) {
      console.error(`[LineHelper]    StatusCode: ${err.statusCode}`);
    }
    console.error(`[LineHelper]    Payload:`, JSON.stringify(messages));
  }
}

/**
 * Reply to a specific replyToken.
 * @param {string} replyToken
 * @param {Array} messages - LINE message objects
 */
async function replyMessage(replyToken, messages) {
  try {
    const lineClient = getClient();
    await lineClient.replyMessage(replyToken, messages);
  } catch (err) {
    console.error(`[LineHelper] ❌ replyMessage failed:`, err.message);
  }
}

/**
 * Download message content (image/video/audio) as a Buffer.
 * Uses LINE's Get Content API with Authorization header.
 * @param {string} messageId
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function getMessageContent(messageId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api-data.line.me",
      path: `/v2/bot/message/${messageId}/content`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    };

    const req = https.request(options, (res) => {
      // Handle redirects (LINE sometimes 302s)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (redirectRes) => {
          const chunks = [];
          redirectRes.on("data", (chunk) => chunks.push(chunk));
          redirectRes.on("end", () => {
            resolve({
              buffer: Buffer.concat(chunks),
              contentType: redirectRes.headers["content-type"] || "image/jpeg",
            });
          });
          redirectRes.on("error", reject);
        });
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`LINE Content API returned ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: res.headers["content-type"] || "image/jpeg",
        });
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * Get cache statistics (for debugging / #sys.status).
 */
function getCacheStats() {
  return {
    groupSummaryCache: groupSummaryCache.size,
    memberProfileCache: memberProfileCache.size,
  };
}

module.exports = {
  getGroupSummary,
  getGroupMemberProfile,
  pushMessage,
  replyMessage,
  getMessageContent,
  getCacheStats,
};
