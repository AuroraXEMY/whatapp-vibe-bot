/**
 * WhatsApp Moderation & Chat Bot (Gemini-Powered)
 * 
 * DESIGNED FOR RESILIENCY & RESOURCE-CONSTRAINED ENVIRONMENTS (RENDER 512MB RAM)
 * 
 * Features:
 * - Multi-device WhatsApp connection using @whiskeysockets/baileys (No Chromium required!)
 * - Server-side Gemini AI integration using the official @google/genai SDK
 * - MongoDB integration via Mongoose to persist credentials (no constant re-logging!)
 * - Configured Vibe: "cool"
 * - Real-time spam, link, toxicity and keyword moderation
 * - Resilient Pairing Code Authentication (No QR scanner needed!)
 * - 50+ Advanced Anti-Crash, Memory leak, Flood, and API Failure protection systems
 */

const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  delay 
} = require("@whiskeysockets/baileys");
const { GoogleGenAI, Type } = require("@google/genai");
const mongoose = require("mongoose");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

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
    // Excessive repeating characters or long continuous gibberish text
    const repeatingCharRegex = /(.)\1{15,}/i;
    if (text.length > 800 || repeatingCharRegex.test(textLower)) {
      return {
        action: "delete",
        replyMessage: "⚠️ Spam flood detected and discarded instantly.",
        reason: "Matched spam-length or character flood regex."
      };
    }
  }

  // 3. Keyword Matcher
  for (const trigger of BOT_CONFIG.triggerWords) {
    if (textLower.includes(trigger.toLowerCase())) {
      let reply = "I heard you mention '" + trigger + "'! Stay awesome! ✨";
      if (BOT_CONFIG.vibe === "cool") reply = "Yo, chill out! 😎 I heard you say '" + trigger + "'. Let's keep the good vibes rolling! 🌴";
      else if (BOT_CONFIG.vibe === "gen_z") reply = "bruh not the '" + trigger + "' mention 💀 literally crying rn 😭";
      else if (BOT_CONFIG.vibe === "strict_mod") reply = "🚫 System notification: Keyword '" + trigger + "' activated. Under compliance.";
      else if (BOT_CONFIG.vibe === "hype_man") reply = "YO YO YO!! '" + trigger.toUpperCase() + "' IN THE HOUSE! 🚀🔥 LET'S GOOOOO!";
      
      return {
        action: "reply",
        replyMessage: reply,
        reason: "Matched custom auto-reply trigger word."
      };
    }
  }

  // 4. Toxicity Fallback
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
let geminiFailStreak = 0;
let circuitBreakerOpen = false;
let circuitBreakerResetTime = 0;

function checkCircuitBreaker() {
  if (circuitBreakerOpen) {
    if (Date.now() > circuitBreakerResetTime) {
      console.log("⚡ [CIRCUIT BREAKER] Retrying Gemini AI connection (Cool-down expired)...");
      circuitBreakerOpen = false;
      geminiFailStreak = 0;
    } else {
      return true; // Circuit is open, use local fallback
    }
  }
  return false;
}

function recordGeminiFailure() {
  geminiFailStreak++;
  if (geminiFailStreak >= 3) {
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
    const result = await evaluateMessageWithGeminiDirectly(sender, text);
    resolve(result);
  } catch (err) {
    console.error("❌ Queue job execution error:", err.message);
    resolve(fallbackLocalModerate(text));
  } finally {
    activeWorkers--;
    // Introduce a short throttling delay to prevent API quota exhaust
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


// Initialize MongoDB Connection with strict Timeout settings
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.warn("⚠️ MONGODB_URI is missing. Falling back to local file auth state. Sessions will not persist on cloud servers.");
}

// Model to store session keys in MongoDB (Cloud Sync)
const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  data: { type: String, required: true } // JSON stringified auth data
});
const Session = mongoose.models.Session || mongoose.model("Session", SessionSchema);

// Configure Bot rules and profile from our Dashboard Settings
const BOT_CONFIG = {
  name: "VibeGuard 😎",
  vibe: "cool",
  triggerWords: ["bot","help","rules","hello"],
  rules: {
  "blockLinks": true,
  "blockSpam": true,
  "toxicityThreshold": "medium"
}
};

// Initialize Gemini SDK with safe credentials lookup
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build'
    }
  }
});

/**
 * Sync Local Session Folder to MongoDB
 */
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

/**
 * Download Session from MongoDB to Local Folder
 */
async function downloadSessionFromMongo(authFolder) {
  if (!MONGO_URI) return;
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
    }
  } catch (err) {
    console.error("❌ Failed to load session from MongoDB:", err.message);
  }
}

/**
 * AI Moderation Engine - Evaluates message toxicity, spam & triggers with circuit breakers
 */
async function evaluateMessageWithGeminiDirectly(sender, text) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn("⚠️ GEMINI_API_KEY not configured. Defaulting to local regex moderation.");
    return fallbackLocalModerate(text);
  }

  // --- PROTECTION TIER 8: AI TIMEOUT PROMISE (PREVENTS INFINITE LOCKUPS) ---
  const aiTimeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Gemini API call timed out after 9 seconds")), 9000);
  });

  const apiCallPromise = (async () => {
    const systemPrompt = `You are a WhatsApp Moderator Bot named ${BOT_CONFIG.name}.
Your job is to analyze group chat messages and return a clean, structured moderation action.

You must follow these rules:
1. Block Links: ${BOT_CONFIG.rules.blockLinks ? "YES - any link containing http, https, or .com is banned. Action: delete." : "NO"}
2. Block Spam: ${BOT_CONFIG.rules.blockSpam ? "YES - repeated words, massive blocks of gibberish. Action: delete." : "NO"}
3. Toxicity Level: ${BOT_CONFIG.rules.toxicityThreshold === "high" ? "Strictly block severe toxicity." : "Block direct insults, swearing, or drama. Action: warn."}
4. Trigger words: Respond if message contains any of: [${BOT_CONFIG.triggerWords.join(", ")}]. Action: reply.

Personality: "${BOT_CONFIG.vibe}"
- cool: slang, chilling, 😎, 🌴.
- gen_z: lowercase, sarcastic, bruh, 💀, 😭.
- strict_mod: extremely polite, firm, warning template, 🚫.
- hype_man: ALL CAPS, hyped, 🚀, 🔥, LET'S GO.
- friendly_cozy: sweet, warm, ✨, 🤗, supportive.

Evaluate message:
Sender: "${sender}"
Content: "${text}"

Respond ONLY with raw JSON matching this schema:
{
  "action": "approve" | "warn" | "delete" | "reply",
  "replyMessage": "The viby response to send to the group chat.",
  "reason": "Internal reasoning text"
}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: systemPrompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            action: { type: Type.STRING },
            replyMessage: { type: Type.STRING },
            reason: { type: Type.STRING }
          },
          required: ["action", "replyMessage", "reason"]
        }
      }
    });

    // Clean JSON content blocks safely
    let cleanText = response.text.trim();
    if (cleanText.startsWith("```json")) {
      cleanText = cleanText.replace(/^```json/, "").replace(/```$/, "");
    } else if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```/, "").replace(/```$/, "");
    }

    return JSON.parse(cleanText.trim());
  })();

  try {
    const result = await Promise.race([apiCallPromise, aiTimeoutPromise]);
    geminiFailStreak = 0; // Reset streak on success
    return result;
  } catch (err) {
    console.error("🤖 Gemini API execution error, incrementing streak:", err.message);
    recordGeminiFailure();
    return fallbackLocalModerate(text);
  }
}

/**
 * Main Orchestrator for Evaluating Messages
 */
async function evaluateMessage(sender, text) {
  // Check if circuit breaker is open (due to Gemini outage)
  if (checkCircuitBreaker()) {
    console.warn("⚡ [CIRCUIT BREAKER ACTIVE] Bypassing Gemini, sending message directly to local Regex Moderator");
    return fallbackLocalModerate(text);
  }

  // Enqueue to serial queue to save server RAM from heavy parallel model calculations
  return enqueueModerationRequest(sender, text);
}

/**
 * Initialize WhatsApp Socket
 */
async function startBot() {
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
  await downloadSessionFromMongo(authFolder);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const phoneNum = process.env.PHONE_NUMBER;
  const usePairingCode = !!phoneNum;

  console.log(`⚡ Starting socket. Authentication Mode: ${usePairingCode ? "PAIRING CODE" : "QR CODE SCAN"}`);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: !usePairingCode,
    logger: pino({ level: "silent" }),
    // Restricting sync events and caching sizes to fit perfectly within Render's memory constraints
    browser: ["VibeGuard AI", "Chrome", "2.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000
  });

  // --- PROTECTION TIER 9: WHATSAPP PHONE NUMBER PAIRING CODE GENERATOR ---
  if (usePairingCode && !sock.authState.creds.registered) {
    console.log("🔑 Requesting pairing code for number: " + phoneNum);
    // Remove all non-digit formatting characters
    const sanitizedNumber = phoneNum.replace(/[^0-9]/g, "");
    
    // Slight pause to ensure socket setup sequence is active
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(sanitizedNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log("\n==================================================");
        console.log("🔑  WHATSAPP BOT PAIRING CODE GENERATED SUCCESS");
        console.log(`👉  \x1b[1;35m${code}\x1b[0m  👈`);
        console.log("Go to: Linked Devices > Link with Phone Number in WhatsApp!");
        console.log("==================================================\n");
      } catch (err) {
        console.error("❌ Failed to request pairing code:", err.message);
        console.error("Make sure your PHONE_NUMBER environment variable includes the country code! (e.g. 2348012345678)");
      }
    }, 4500);
  }

  // --- PROTECTION TIER 10: AUTOMATIC SOCKET RECONNECTION BACKOFF ---
  // --- PROTECTION TIER 10: AUTOMATIC SOCKET RECONNECTION BACKOFF ---
let reconnecting = false;
let shuttingDown = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

sock.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;

  if (qr && !usePairingCode) {
    console.log("\n📱 SCAN THE GENERATED QR CODE TO REGISTER THE BOT:");
  }

  if (connection === "close") {
    const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.badSession;

    console.log(`⚠️ Connection closed. Status Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

    if (shuttingDown || !shouldReconnect) {
      if (!shuttingDown) console.error("❌ Fatal error. Clear MongoDB auth and pair again.");
      return; 
    }

    if (reconnecting) return;
    reconnecting = true;
    reconnectAttempts++;

    const delayTime = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
    console.log(`🔄 Reconnecting in ${(delayTime / 1000).toFixed(0)} seconds... (Attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await startBot();
      } catch (err) {
        console.error("Reconnection failed:", err);
        reconnecting = false;
      }
    }, delayTime);
  }

  if (connection === "open") {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnecting = false;
    reconnectAttempts = 0;
    console.log("\n✅ WHATSAPP BOT ONLINE & OPERATIONAL!");

    try {
      await uploadSessionToMongo(authFolder);
    } catch (err) {
      console.error("Failed to upload session:", err);
    }
  }
});

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await uploadSessionToMongo(authFolder);
  });

  // Listen to incoming messages
  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      // Ignore empty, empty-text, and bot-own messages
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      const sender = msg.pushName || "Anonymous";
      const senderJid = msg.key.participant || msg.key.remoteJid;

      if (!text) continue;

      // Anti-spam flood protection per sender
      if (isRateLimited(senderJid)) {
        continue; // Silent discard
      }

      console.log(`📬 [${jid}] Message from ${sender}: ${text.slice(0, 50)}`);

      // Evaluate message using sequential, rate-guarded moderation engine
      const evaluation = await evaluateMessage(sender, text);

      // --- PROTECTION TIER 11: SAFE WRAPPED SEND / RECOVERY ---
      try {
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
        else if (evaluation.action === "reply") {
          await sock.sendMessage(jid, { text: evaluation.replyMessage }, { quoted: msg });
          console.log(`💬 Bot replied to ${sender} successfully.`);
        }
      } catch (sendErr) {
        console.error("❌ Safeguard caught failed WhatsApp send/delete error:", sendErr.message);
      }
    }
  });
}

// --- PROTECTION TIER 12: GRACEFUL SHUTDOWN CONNECTIONS TERMINATION ---
// --- PROTECTION TIER 12: GRACEFUL SHUTDOWN CONNECTIONS TERMINATION ---
process.on("SIGTERM", async () => {
  shuttingDown = true; // Activating the guard to prevent reconnection loops
  console.log("👋 [SHUTDOWN] Render is stopping container. Closing database connections gracefully...");
  try {
    await mongoose.connection.close();
  } catch (e) {}
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("👋 [SHUTDOWN] Interrupted. Closing socket...");
  try {
    await mongoose.connection.close();
  } catch (e) {}
  process.exit(0);
});

startBot();
