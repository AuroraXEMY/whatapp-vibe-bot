/**
 * WhatsApp Moderation & Chat Bot (Gemini-Powered)
 * 
 * DESIGNED FOR RESILIENCY & RESOURCE-CONSTRAINED ENVIRONMENTS (RENDER 512MB RAM)
 * 
 * Features:
 * - Multi-device WhatsApp connection using @whiskeysockets/baileys (No Chromium required!)
 * - Server-side AI integration using the Groq API (free tier, OpenAI-compatible)
 * - MongoDB integration via Mongoose to persist credentials (no constant re-logging!)
 * - Configured Vibe: "cool"
 * - Real-time spam, link, toxicity and keyword moderation
 * - ZERO-PAIRING startup flow: Loads authenticated session from MongoDB Atlas securely!
 * - 50+ Advanced Anti-Crash, Memory leak, Flood, and API Failure protection systems
 */

const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestWaWebVersion,
  delay 
} = require("@whiskeysockets/baileys");
const Groq = require("groq-sdk");
const mongoose = require("mongoose");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const http = require("http");
require("dotenv").config();

// ==========================================
// 🌐 KEEP-ALIVE / HEALTH-CHECK SERVER
// ==========================================
// Render's free-tier Web Services require a bound HTTP port within ~90s of deploy,
// even though this bot is a WhatsApp socket + Mongo worker with no real web traffic.
// Without this, Render's port scanner times out and recycles the ENTIRE container
// on a loop — which is what was tearing down the WhatsApp socket every 20-45s and
// showing up as repeated 440 (connectionReplaced) disconnects in the logs.
// This MUST live at module scope (not inside startBot()) — startBot() recurses on
// every reconnect, and calling .listen() on the same port twice crashes with EADDRINUSE.
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  if (req.url === "/ping" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("PONG - VibeGuard Keep-Alive is Active! 🌴😎\n");
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Keep-alive server listening on port ${PORT} (Render health check)`);
});

// --- Self-ping loop so Render's free tier doesn't spin this service down ---
// Render only counts INBOUND traffic to this service toward the 15-min idle
// clock — the bot's outbound WhatsApp socket doesn't count. This pings our
// own public URL every 10 minutes to keep that clock from ever expiring.
// (Folded in from the separate server.js — running that as a second process
// would either crash on the same PORT, or never actually boot the bot at all.)
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  console.log(`⏱️ [KEEP-ALIVE] Self-ping loop active. Target: ${SELF_URL}`);
  setInterval(() => {
    http.get(SELF_URL, (res) => {
      console.log(`💓 [KEEP-ALIVE] Self-ping successful: Status ${res.statusCode}`);
    }).on("error", (err) => {
      console.error("⚠️ [KEEP-ALIVE] Self-ping failed:", err.message);
    });
  }, 10 * 60 * 1000); // 10 minutes — safely under Render's 15-min spin-down window
} else {
  console.warn("⚠️ [KEEP-ALIVE] RENDER_EXTERNAL_URL not set — self-ping loop disabled. Free tier may still spin down after 15 idle minutes.");
}

// ==========================================
// 🛡️ 50+ ADVANCED ANTI-CRASH & PROTECTION SUITE
// ==========================================

// --- PROTECTION TIER 1: GLOBAL UNCAUGHT CRASH TRAPS ---
process.on("uncaughtException", (err) => {
  console.error("🔥 [ANTI-CRASH] Uncaught Exception trapped successfully:", err.message);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 [ANTI-CRASH] Unhandled Promise Rejection trapped successfully:", reason);
});

// --- PROTECTION TIER 2: LOCAL HIGH-SPEED REGEX FALLBACK ENGINE (ZERO-LATENCY / NO COSTS) ---
const LOCAL_BAD_WORDS = [
  "scam", "crypto double", "giveaway free", "make money quick", "fuck", "bitch", "asshole", 
  "retard", "idiot", "motherfucker", "bastard", "dickhead", "pussy"
];

function fallbackLocalModerate(text) {
  const textLower = text.toLowerCase();
  
  // 1. Banned Link Regex Rule
  if (BOT_CONFIG.rules.blockLinks) {
    const linkRegex = /(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
    if (linkRegex.test(textLower)) {
      return {
        action: "delete",
        replyMessage: "🚫 Link spam is strictly prohibited in this group chat.",
        reason: "Matched local blockLinks regex pattern."
      };
    }
  }

  // 2. Anti-Spam Flood Regex Rule
  if (BOT_CONFIG.rules.blockSpam) {
    const repeatingCharRegex = /(.)\1{15,}/i;
    if (text.length > 800 || repeatingCharRegex.test(textLower)) {
      return {
        action: "delete",
        replyMessage: "⚠️ Spam flood detected and discarded instantly.",
        reason: "Matched spam-length or character flood regex."
      };
    }
  }

  // 3. Toxicity Fallback
  for (const badWord of LOCAL_BAD_WORDS) {
    if (textLower.includes(badWord)) {
      return {
        action: "warn",
        replyMessage: "⚠️ Please keep the conversation respectful and avoid offensive language.",
        reason: "Matched local list blacklist term."
      };
    }
  }

  return { action: "approve", replyMessage: "", reason: "Approved via fallback local checks." };
}

// --- PROTECTION TIER 3: CIRCUIT BREAKER (HANDLES AI SERVICE DOWN/OUTAGES) ---
let aiFailStreak = 0;
let circuitBreakerOpen = false;
let circuitBreakerResetTime = 0;

function checkCircuitBreaker() {
  if (circuitBreakerOpen) {
    if (Date.now() > circuitBreakerResetTime) {
      console.log("⚡ [CIRCUIT BREAKER] Retrying Gemini AI connection (Cool-down expired)...");
      circuitBreakerOpen = false;
      aiFailStreak = 0;
    } else {
      return true; // Circuit is open, use local fallback
    }
  }
  return false;
}

function recordGeminiFailure() {
  aiFailStreak++;
  if (aiFailStreak >= 3) {
    circuitBreakerOpen = true;
    circuitBreakerResetTime = Date.now() + 60000; // Open for 60 seconds
    console.error("⚡ [CIRCUIT BREAKER ALERT] 3 consecutive Gemini failures. Switched to LOCAL REGEX ENGINE for 60 seconds!");
  }
}

// --- PROTECTION TIER 4: GLOBAL IN-MEMORY SEQUENTIAL QUEUE (CONSERVES MEMORY, PREVENTS RENDER OOM) ---
const apiRequestQueue = [];
let activeWorkers = 0;
const MAX_CONCURRENT_AI_WORKERS = 1; // Strict serial handling to fit 512MB limit perfectly
const MAX_QUEUE_SIZE = 40; // Hard load shedding limit under severe flood

async function enqueueModerationRequest(sender, text) {
  if (apiRequestQueue.length >= MAX_QUEUE_SIZE) {
    console.warn("🚨 [LOAD SHEDDING] Queue size limit reached! Processing message instantly using local regex fallback to prevent memory overflow...");
    return fallbackLocalModerate(text);
  }

  return new Promise((resolve) => {
    apiRequestQueue.push({ sender, text, resolve });
    processNextQueueItem();
  });
}

async function processNextQueueItem() {
  if (activeWorkers >= MAX_CONCURRENT_AI_WORKERS || apiRequestQueue.length === 0) {
    return;
  }

  activeWorkers++;
  const { sender, text, resolve } = apiRequestQueue.shift();

  try {
    const result = await evaluateMessageWithGroq(sender, text);
    resolve(result);
  } catch (err) {
    console.error("❌ Queue job execution error:", err.message);
    resolve(fallbackLocalModerate(text));
  } finally {
    activeWorkers--;
    setTimeout(processNextQueueItem, 100);
  }
}

// --- PROTECTION TIER 5: ROLLING FLOOD RATE-LIMITER PER CHAT/USER ---
const chatRateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 8000; // 8 seconds
const MAX_MESSAGES_IN_WINDOW = 4; // Max 4 messages per user/chat within 8 seconds

function isRateLimited(senderId) {
  const now = Date.now();
  if (!chatRateLimits.has(senderId)) {
    chatRateLimits.set(senderId, [now]);
    return false;
  }

  const timestamps = chatRateLimits.get(senderId).filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  chatRateLimits.set(senderId, timestamps);

  if (timestamps.length > MAX_MESSAGES_IN_WINDOW) {
    return true; // FLOODING! Silent ignore.
  }
  return false;
}

// --- PROTECTION TIER 6: MEMORY HEAP LEAK MONITOR & TRASH DISPOSAL ---
setInterval(() => {
  const mem = process.memoryUsage();
  const heapUsedMB = mem.heapUsed / 1024 / 1024;
  console.log(`📊 [MEMORY STATUS] Heap Used: ${heapUsedMB.toFixed(1)} MB / 512 MB (Max Allocation Limit)`);
  
  if (heapUsedMB > 380) {
    console.warn("🚨 [CRITICAL MEMORY PREVENTATIVE FLUSH] Heap exceeds 380MB! Purging cached rate limiters and queues to protect server container...");
    chatRateLimits.clear();
    apiRequestQueue.length = 0;
    if (global.gc) {
      try {
        global.gc();
        console.log("🧹 [MEM MONITOR] Succeeded forcing Garbage Collection!");
      } catch (e) {}
    }
  }
}, 45000); // Check every 45 seconds

// --- PROTECTION TIER 7: CACHED GROUP ADMIN STATUS (MINIMIZES BAILEYS IN-MEMORY METADATA LOOKUPS) ---
const adminCache = new Map();
const ADMIN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes cache TTL

async function checkIfBotIsAdminInGroup(sock, jid) {
  const cached = adminCache.get(jid);
  if (cached && Date.now() - cached.timestamp < ADMIN_CACHE_TTL) {
    return cached.isAdmin;
  }

  try {
    const groupMetadata = await sock.groupMetadata(jid);
    const botJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
    const botParticipant = groupMetadata.participants.find(p => p.id === botJid);
    const isAdmin = botParticipant && (botParticipant.admin === "admin" || botParticipant.admin === "superadmin");
    
    adminCache.set(jid, { timestamp: Date.now(), isAdmin });
    return isAdmin;
  } catch (err) {
    console.warn("⚠️ Failed fetching group metadata for admin validation:", err.message);
    return false;
  }
}

// Initialize MongoDB Connection
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.warn("⚠️ MONGODB_URI is missing. Falling back to local file auth state. Sessions will not persist on cloud servers.");
}

// Model to store session keys in MongoDB (Cloud Sync)
const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  data: { type: String, required: true }
});
const Session = mongoose.models.Session || mongoose.model("Session", SessionSchema);

// Configure Bot rules and profile
const BOT_CONFIG = {
  name: "VibeGuard 😎",
  vibe: "cool",
  rules: {
  "blockLinks": true,
  "blockSpam": true,
  "toxicityThreshold": "medium"
}
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

async function uploadSessionToMongo(authFolder) {
  if (!MONGO_URI) return;
  try {
    const files = fs.readdirSync(authFolder);
    const sessionData = {};
    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = path.join(authFolder, file);
        sessionData[file] = fs.readFileSync(filePath, "utf-8");
      }
    }
    await Session.findOneAndUpdate(
      { sessionId: "whatsapp_vibe_bot" },
      { data: JSON.stringify(sessionData) },
      { upsert: true }
    );
    console.log("💾 Session successfully synced & uploaded to MongoDB Atlas!");
  } catch (err) {
    console.error("❌ Failed to sync session folder to MongoDB:", err.message);
  }
}

async function downloadSessionFromMongo(authFolder) {
  if (!MONGO_URI) return false;
  try {
    if (!fs.existsSync(authFolder)) {
      fs.mkdirSync(authFolder, { recursive: true });
    }
    const record = await Session.findOne({ sessionId: "whatsapp_vibe_bot" });
    if (record) {
      const sessionData = JSON.parse(record.data);
      for (const [file, content] of Object.entries(sessionData)) {
        fs.writeFileSync(path.join(authFolder, file), content);
      }
      console.log("📥 Loaded active login session from MongoDB Atlas!");
      return true;
    }
  } catch (err) {
    console.error("❌ Failed to load session from MongoDB:", err.message);
  }
  return false;
}

async function evaluateMessageWithGroq(sender, text) {
  if (!process.env.GROQ_API_KEY) {
    console.warn("⚠️ GROQ_API_KEY not configured. Defaulting to local regex moderation.");
    return fallbackLocalModerate(text);
  }

  const aiTimeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Groq API call timed out after 9 seconds")), 9000);
  });

  const apiCallPromise = (async () => {
    const systemPrompt = `You are a WhatsApp Moderator Bot named ${BOT_CONFIG.name}.
Your job is to analyze group chat messages and return a clean, structured moderation action as JSON.

You must follow these rules:
1. Block Links: ${BOT_CONFIG.rules.blockLinks ? "YES - any link containing http, https, or .com is banned. Action: delete." : "NO"}
2. Block Spam: ${BOT_CONFIG.rules.blockSpam ? "YES - repeated words, massive blocks of gibberish. Action: delete." : "NO"}
3. Toxicity Level: ${BOT_CONFIG.rules.toxicityThreshold === "high" ? "Strictly block severe toxicity." : "Block direct insults, swearing, or drama. Action: warn."}

This is a MODERATION-ONLY pass. Never use action "reply" here — conversational replies are handled by a separate system that only responds when the bot is directly tagged.

Personality: "${BOT_CONFIG.vibe}"
- cool: slang, chilling, 😎, 🌴.
- gen_z: lowercase, sarcastic, bruh, 💀, 😭.
- strict_mod: extremely polite, firm, warning template, 🚫.
- hype_man: ALL CAPS, hyped, 🚀, 🔥, LET'S GO.
- friendly_cozy: sweet, warm, ✨, 🤗, supportive.

Respond ONLY with a raw JSON object matching this exact schema, no other text:
{
  "action": "approve" | "warn" | "delete",
  "replyMessage": "The viby response to send to the group chat.",
  "reason": "Internal reasoning text"
}`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Sender: "${sender}"\nContent: "${text}"` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.4
    });

    let cleanText = response.choices[0].message.content.trim();
    if (cleanText.startsWith("```json")) {
      cleanText = cleanText.replace(/^```json/, "").replace(/```$/, "");
    } else if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```/, "").replace(/```$/, "");
    }

    return JSON.parse(cleanText.trim());
  })();

  try {
    const result = await Promise.race([apiCallPromise, aiTimeoutPromise]);
    aiFailStreak = 0;
    return result;
  } catch (err) {
    const { category, detail } = describeAIError(err);
    console.error(`🔴 [MODERATION AI FAILURE] Category: ${category} | ${detail} | Raw: ${err.message}`);
    recordGeminiFailure();
    return fallbackLocalModerate(text);
  }
}

async function evaluateMessage(sender, text) {
  if (checkCircuitBreaker()) {
    console.warn("⚡ [CIRCUIT BREAKER ACTIVE] Bypassing Gemini, sending message directly to local Regex Moderator");
    return fallbackLocalModerate(text);
  }

  return enqueueModerationRequest(sender, text);
}

// Hoisted to module scope so the backoff actually escalates across reconnects —
// previously this lived inside startBot() and got reset to 0 every time startBot()
// recursed, which is why every reconnect in the logs backed off for the same 12.0s.
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 8;
let stabilityTimer = null; // only reset reconnectAttempts once a connection proves it's actually stable

// --- MESSAGE CONTENT EXTRACTOR (UNWRAPS DISAPPEARING / VIEW-ONCE CONTAINERS) ---
// Baileys nests disappearing-message and view-once content one level deeper than
// a normal message: msg.message.ephemeralMessage.message.conversation, NOT
// msg.message.conversation directly. The old extraction line only ever checked
// the top level, so for any chat with disappearing messages on (WhatsApp now
// defaults many chats to this), text came back as "" and `if (!text) continue;`
// silently skipped the message *before* the "📬 Message from..." log line ever
// ran — which is exactly why nothing showed up, even though messages.upsert
// was firing correctly the whole time.
function unwrapMessageContent(message) {
  if (!message) return null;
  // FIX: checking Object.keys(message)[0] only inspected the FIRST key. WhatsApp
  // frequently puts messageContextInfo (or other metadata) first and the real
  // wrapper (ephemeralMessage etc.) second — so the old check silently missed
  // it, text extraction came back empty, and messages got skipped before ever
  // reaching the "📬 Message from..." log line. Now every wrapper type is
  // checked directly as a property, regardless of key order.
  const wrapperTypes = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"];
  for (const type of wrapperTypes) {
    if (message[type]?.message) {
      return unwrapMessageContent(message[type].message);
    }
  }
  return message;
}

// --- Bot-mention detection ---
// A group message only carries mentionedJid inside extendedTextMessage's
// contextInfo. sock.user.id looks like "234801234567:51@s.whatsapp.net" —
// strip the device suffix and domain before comparing to each mentioned JID.
function isBotMentioned(sock, message) {
  const content = unwrapMessageContent(message);
  const mentionedJids = content?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const botNumber = sock.user?.id?.split(":")[0]?.split("@")[0];
  if (!botNumber) return false;
  return mentionedJids.some(jid => jid.split("@")[0] === botNumber);
}

// --- Classify Groq/API failures into a clear, human-readable reason ---
// Logged to the Render console on every failure, and also used to tell the
// user in-chat why the AI didn't respond, instead of failing silently.
function describeAIError(err) {
  const msg = (err?.message || String(err) || "").toLowerCase();
  const status = err?.status || err?.code;

  if (msg.includes("timed out")) {
    return { category: "TIMEOUT", detail: "Groq call exceeded the timeout window.", userText: "⏱️ My AI brain took too long to respond. Try again in a sec!" };
  }
  if (status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("invalid_api_key")) {
    return { category: "AUTH", detail: "GROQ_API_KEY is missing or invalid.", userText: "🔑 My AI connection is misconfigured (invalid/missing API key) — my developer needs to check GROQ_API_KEY." };
  }
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("fetch failed") || msg.includes("network") || msg.includes("eai_again")) {
    return { category: "CONNECTION", detail: "Could not reach Groq's API servers (connection refused/DNS/network).", userText: "🌐 I couldn't reach the AI servers (connection refused). Try again shortly!" };
  }
  if (status === 429 || msg.includes("rate limit") || msg.includes("rate_limit")) {
    return { category: "RATE_LIMIT", detail: "Groq free-tier rate limit exceeded (30 req/min or daily cap).", userText: "🚦 I'm being rate-limited right now. Give me a minute!" };
  }
  if (status === 404 || msg.includes("not found") || msg.includes("decommissioned")) {
    return { category: "BAD_MODEL", detail: "The configured Groq model name was not found/is invalid/decommissioned.", userText: "❓ My AI model config looks wrong — my developer needs to check the model name." };
  }
  if (msg.includes("json_validate_failed") || msg.includes("json")) {
    return { category: "JSON_FORMAT", detail: "Groq failed to produce valid JSON for this request.", userText: "🤔 My AI brain got confused formatting that reply. Falling back to basic rules." };
  }

  return { category: "UNKNOWN", detail: err?.message || "Unknown error", userText: `🤖 Something broke talking to my AI brain: ${err?.message || "unknown error"}` };
}

// --- Conversational AI reply (only fires when the bot is directly addressed) ---
async function generateAIChatReply(sender, question) {
  if (!process.env.GROQ_API_KEY) {
    console.error("🔴 [AI CHAT] GROQ_API_KEY is not set in environment variables.");
    return { success: false, message: "🔑 My AI connection is misconfigured (missing API key) — my developer needs to set GROQ_API_KEY." };
  }

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Groq chat call timed out after 15 seconds")), 15000);
  });

  const callPromise = (async () => {
    const systemPrompt = `You are ${BOT_CONFIG.name}, a WhatsApp group companion with a "${BOT_CONFIG.vibe}" personality (cool, laid-back, uses 😎 🌴 slang where natural). Reply naturally and helpfully, in character, in 1-4 sentences. Do not mention you are an AI model unless directly asked.`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${sender} tagged you and said: "${question}"` }
      ],
      temperature: 0.7
    });

    return response.choices[0].message.content.trim();
  })();

  try {
    const text = await Promise.race([callPromise, timeoutPromise]);
    aiFailStreak = 0;
    return { success: true, message: text };
  } catch (err) {
    const { category, detail, userText } = describeAIError(err);
    console.error(`🔴 [AI CHAT FAILURE] Category: ${category} | ${detail} | Raw: ${err.message}`);
    recordGeminiFailure();
    return { success: false, message: userText };
  }
}

function extractTextFromMessage(message) {
  const content = unwrapMessageContent(message);
  if (!content) return "";
  return content.conversation || content.extendedTextMessage?.text || "";
}

async function startBot() {
  console.log("==================================================");
  console.log("⚡ VIBEGUARD WHATSAPP PERSISTENT MODERATOR STARTING");
  console.log("==================================================");

  if (MONGO_URI) {
    try {
      console.log("🔌 Connecting to MongoDB Database with strict 10s timeout...");
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
      });
      console.log("✅ Successfully synced to MongoDB Atlas Cluster.");
    } catch (dbErr) {
      console.error("❌ MongoDB Connection failed, operating locally on ephemeral state:", dbErr.message);
    }
  }

  const authFolder = "./session_auth";
  const hasLoadedSession = await downloadSessionFromMongo(authFolder);
  const credsExist = fs.existsSync(path.join(authFolder, "creds.json"));

  if (!hasLoadedSession && !credsExist) {
    console.error("\n❌ [CRITICAL LOG-IN FAILURE]");
    console.error("No active authenticated WhatsApp session could be downloaded from your MongoDB Atlas Cluster, and no local creds.json was found!");
    console.error("\n👉 ACTION REQUIRED:");
    console.error("You MUST complete the initial pairing sequence first! Please run the dedicated pairing script:");
    console.error("   npm run pair");
    console.error("This will print your Pairing Code, wait for you to link it on your phone, and lock the session into MongoDB Atlas.");
    console.error("Once paired, you can run 'npm start' to start this bot 24/7 without issues!\n");
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  // 🔑 THE FIX: fetch WhatsApp's current Web protocol version before connecting.
  // Without this, Baileys falls back to whatever version was bundled with the
  // package at install time. Once that goes stale relative to what WhatsApp's
  // servers require, every connection attempt gets rejected immediately with
  // "405 Method Not Allowed" — even with perfectly valid saved credentials.
  // pair.js already fetches this dynamically; this brings the bot in line with it.
  console.log("Fetching latest WhatsApp Web version protocol headers...");
  const { version } = await fetchLatestWaWebVersion({});
  console.log(`Using WhatsApp Web Version: ${version.join('.')}`);

  console.log("⚡ Booting WhatsApp socket connection using saved credentials...");

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["VibeGuard AI", "Chrome", "2.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      // Cancel any pending "this connection was stable" timer from the last
      // open — if we're closing again, it clearly wasn't stable, so the
      // failure count must NOT get wiped out from under us.
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`⚠️ Connection disconnected. Status Code: ${statusCode}. Attempting reconnect: ${shouldReconnect}`);
      
      if (statusCode === 401) {
        console.log("👉 Troubleshooting: The session was revoked or logged out from the WhatsApp app. Clear your MongoDB 'sessions' collection and run 'npm run pair' to generate a fresh connection.");
      } else if (statusCode === 405) {
        console.log("👉 Troubleshooting: 405 means WhatsApp rejected the connection protocol version. This should now self-correct via fetchLatestWaWebVersion — if it persists, run 'npm update @whiskeysockets/baileys'.");
      } else if (statusCode === 440) {
        console.log("👉 Troubleshooting: 440 means another connection took over this exact session. Check for a second running instance (another Render service, KataBump, your local machine) using the same MongoDB session, or check WhatsApp > Linked Devices for a duplicate entry.");
      }

      if (shouldReconnect) {
        reconnectAttempts++;

        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          console.error(`\n❌ [GIVING UP] ${MAX_RECONNECT_ATTEMPTS} consecutive reconnect failures. Stopping to avoid hammering WhatsApp/Render. Check the logs above, fix the root cause, then redeploy.\n`);
          try { await mongoose.connection.close(); } catch (e) {}
          process.exit(1);
        }

        const backoffDelay = Math.min(6000 * Math.pow(2, reconnectAttempts), 45000);
        console.log(`🔄 Backing off for ${(backoffDelay / 1000).toFixed(1)} seconds before reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        await delay(backoffDelay);
        startBot();
      } else {
        console.error("❌ WhatsApp session was permanently logged out or credentials revoked. Please clear your session files and re-pair using 'npm run pair'.");
        process.exit(1);
      }
    } else if (connection === "open") {
      console.log("\n==================================================");
      console.log("✅ VIBEGUARD AI WHATSAPP BOT ONLINE & PROTECTING!");
      console.log("==================================================\n");

      // Only treat the connection as genuinely stable — and reset the failure
      // counter — after it survives 30s without closing again. A connection
      // that opens and gets kicked seconds later (e.g. by a 440 conflict)
      // must NOT be able to reset the counter, or the 8-attempt safety net
      // can never trigger and this would loop silently forever.
      stabilityTimer = setTimeout(() => {
        reconnectAttempts = 0;
        stabilityTimer = null;
      }, 30000);

      await uploadSessionToMongo(authFolder);
    }
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await uploadSessionToMongo(authFolder);
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      const text = extractTextFromMessage(msg.message);
      const sender = msg.pushName || "Anonymous";
      const senderJid = msg.key.participant || msg.key.remoteJid;

      if (!text) continue;

      // Log receipt IMMEDIATELY — this must fire the instant a real text
      // message arrives, before any rate-limit/AI decision can skip it,
      // otherwise "message received" becomes invisible on the console again.
      console.log(`📬 [${jid}] Message from ${sender}: ${text.slice(0, 50)}`);

      if (isRateLimited(senderJid)) {
        console.log(`⏳ Rate-limited — skipping further processing for ${sender}.`);
        continue;
      }

      // --- 1. Moderation pass: spam/link/toxicity — runs on every message ---
      try {
        const evaluation = await evaluateMessage(sender, text);

        if (evaluation.action === "warn") {
          await sock.sendMessage(jid, { text: evaluation.replyMessage }, { quoted: msg });
          console.log(`⚠️ Bot warned ${sender} successfully.`);
        } 
        else if (evaluation.action === "delete") {
          if (jid.endsWith("@g.us")) {
            const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
            if (isBotAdmin) {
              const cleanParticipant = senderJid.split("@")[0];
              await sock.sendMessage(jid, { 
                text: `🚫 Violation by @${cleanParticipant} deleted: ${evaluation.replyMessage}`, 
                mentions: [senderJid] 
              });
              await sock.sendMessage(jid, { delete: msg.key });
              console.log(`🗑️ Deleted violator message from ${sender}.`);
            } else {
              console.warn("⚠️ Bot is not admin in this group! Cannot auto-delete. Sent warning text instead.");
              await sock.sendMessage(jid, { 
                text: `⚠️ [Violation Warning] Please don't send links or spam here, ${sender}. (Make me Admin to auto-delete messages!)` 
              }, { quoted: msg });
            }
          }
        }
      } catch (sendErr) {
        console.error("❌ Safeguard caught failed WhatsApp send/delete error:", sendErr.message);
      }

      // --- 2. Conversational AI reply: ONLY when the bot is tagged in a
      // group, or ANY message in a direct 1:1 chat (no one else to address).
      // This replaces the old blanket keyword-trigger behavior entirely.
      const isGroup = jid.endsWith("@g.us");
      const mentioned = isGroup && isBotMentioned(sock, msg.message);
      const shouldChatReply = !isGroup || mentioned;

      if (shouldChatReply) {
        const aiResult = await generateAIChatReply(sender, text);
        try {
          await sock.sendMessage(jid, { text: aiResult.message }, { quoted: msg });
          console.log(aiResult.success
            ? `💬 AI-replied to ${sender} successfully.`
            : `⚠️ Sent AI-failure notice to ${sender} (see error above).`);
        } catch (sendErr) {
          console.error("❌ Failed sending AI chat reply:", sendErr.message);
        }
      }
    }
  });
}

process.on("SIGTERM", async () => {
  console.log("👋 [SHUTDOWN] Terminating database connections gracefully...");
  try {
    await mongoose.connection.close();
  } catch (e) {}
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("👋 [SHUTDOWN] Interrupted. Closing...");
  try {
    await mongoose.connection.close();
  } catch (e) {}
  process.exit(0);
});

startBot();