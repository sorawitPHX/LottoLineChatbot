🧠 Knowledge Base: LINE Group Message Forwarder Bot (cPanel/Node.js)

<system_prompt>
Senior Node.js Backend Developer & LINE Messaging API Expert

Develop a highly optimized, stateful LINE Webhook service that crawls messages from ~40 source groups, applies strict filtering rules from a cached Google Sheets configuration, and forwards matched messages to a single destination group.


Strictly adhere to the Logic Flow. Bad keywords ALWAYS override Good keywords.
Zero tolerance for API Rate Limits. Aggressive in-memory caching is MANDATORY for Google Sheets API and LINE Profile/Group APIs.
Ensure cPanel compatibility (CommonJS or properly bundled ESM, port handling via process.env.PORT).

</system_prompt>

🛠️ 1. Technical Stack & Infrastructure

Runtime: Node.js (cPanel environment)

Framework: Express.js

Integrations: @line/bot-sdk, googleapis (Service Account JSON)

State Management: In-memory caching (node-cron or setInterval, TTL = 5 mins)

🗄️ 2. Configuration Schema (Google Sheets)

Data source is a 2-column Google Sheet (Key, Value). System must parse and cache this object:

{
  "SchemaDefinition": {
    "admin_group_id": { "type": "string", "desc": "Target LINE Group ID (Destination)" },
    "debug_mode": { "type": "enum", "values": ["เปิด", "ปิด"], "desc": "Toggle secret commands" },
    "bot_status": { "type": "enum", "values": ["เปิด", "ปิด"], "desc": "Global kill switch" },
    "time_limit_status": { "type": "enum", "values": ["เปิด", "ปิด"], "desc": "Enable time-based filtering" },
    "time_start": { "type": "string", "format": "HH:mm", "desc": "Operating start time" },
    "time_end": { "type": "string", "format": "HH:mm", "desc": "Operating end time" },
    "forward_image": { "type": "enum", "values": ["เปิด", "ปิด"], "desc": "Allow image payloads" },
    "forward_mode": { "type": "enum", "values": ["คัดกรอง", "ดึงทั้งหมด"], "desc": "Filtering strictly vs Forward all" },
    "good_keywords": { "type": "array", "separator": ",", "desc": "Whitelist (e.g., ซื้อ,โอน)" },
    "bad_keywords": { "type": "array", "separator": ",", "desc": "Blacklist (e.g., ยกเลิก,สวัสดี)" }
  }
}


⚙️ 3. Core Logic Flow (Hierarchical Evaluation)

Evaluate every incoming event from LINE Webhook sequentially:

Phase 1: Pre-flight & Secret Commands

IF debug_mode === "เปิด" AND event.message.text === "#getid"

-> Reply with groupId and userId -> TERMINATE

IF event.message.text matches System Commands:

-> #sys.reload: Clear RAM cache, fetch Google Sheets immediately -> Reply status -> TERMINATE

-> #sys.status: Reply current config state from RAM -> TERMINATE

-> #sys.ping: Reply "Pong!" -> TERMINATE

Phase 2: Global Constraints

IF bot_status === "ปิด" -> DROP

IF event.source.groupId === admin_group_id -> DROP (Anti-Infinite Loop)

IF time_limit_status === "เปิด":

-> Parse current server time (Asia/Bangkok)

-> IF Current Time < time_start OR Current Time > time_end -> DROP

Phase 3: Payload Evaluation (The Filter)

IF event.message.type === "image":

-> IF forward_image === "เปิด" -> PASS

-> ELSE -> DROP

IF event.message.type === "text":

-> IF forward_mode === "ดึงทั้งหมด" -> PASS

-> IF forward_mode === "คัดกรอง":

-> Check Blacklist (bad_keywords): IF matched -> DROP (Highest Priority)

-> Check Whitelist (good_keywords): IF matched -> PASS

-> ELSE -> DROP

ELSE (Stickers, Videos, etc.) -> DROP

Phase 4: Data Enrichment & Execution

(For PASS payloads only)

Await getGroupSummary(groupId) (Must use Cache TTL)

Await getGroupMemberProfile(groupId, userId) (Must use Cache TTL, Fallback to "ไม่ทราบชื่อ" if error)

Construct Message:
📌 จากกลุ่ม: {groupName}
👤 ลูกค้า: {displayName}
💬 ข้อความ: {text}

Execute client.pushMessage(admin_group_id, payload)

🚫 4. Anti-Patterns (Do NOT do this)

❌ Real-time DB Queries: DO NOT fetch Google Sheets inside the Webhook payload lifecycle.

❌ Missing Catch Blocks: DO NOT leave LINE API calls without try-catch. If getGroupMemberProfile fails (e.g., user blocked bot), the whole webhook MUST NOT crash.

❌ Infinite Forwarding Loops: DO NOT omit the check if (groupId === admin_group_id) return;.

❌ Regex Catastrophic Backtracking: DO NOT use complex Regex for keyword matching. Use simple string .includes() or basic boundary matching.

✅ 5. Definition of Done (DoD)

[ ] Express server exposes /webhook endpoint validating LINE Signature correctly.

[ ] Google Sheets cache initializes on server startup and refreshes every N minutes automatically.

[ ] Memory caching mechanism handles groupId -> groupName mapping to prevent LINE API HTTP 429 limits.

[ ] #sys.reload successfully mutates the global config object without restarting the Node process.

[ ] Deploys seamlessly on cPanel via standard Application Manager (entry point isolated, e.g., app.js).

📖 6. Glossary

DROP: Terminate the webhook execution gracefully (return res.status(200).send('OK')). Do not push any message.

PASS: Payload meets all criteria and proceeds to the Enrichment and Execution phase.

Source Group: Any of the ~40 customer groups where the bot is invited.

Destination Group (admin_group_id): The single centralized group where filtered messages are pushed.