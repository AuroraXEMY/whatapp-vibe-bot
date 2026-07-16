/**
 * WhatsApp Vibe & Chat Companion Bot — persona name "Nayla"
 * 
 * DESIGNED FOR RESILIENCY & RESOURCE-CONSTRAINED ENVIRONMENTS (RENDER 512MB RAM)
 * 
 * Features:
 * - Multi-device WhatsApp connection using @whiskeysockets/baileys (No Chromium required!)
 * - Multi-provider AI with automatic failover: Groq -> Cerebras (up to 3 keys) -> Mistral
 *   (all via plain fetch against each provider's OpenAI-compatible endpoint — no extra SDKs)
 * - MongoDB integration via Mongoose to persist credentials (no constant re-logging!)
 * - A VIBE bot, not a moderator: NEVER deletes messages or issues formal warnings. It may
 *   comment/react on links, gibberish, or drama, in-character, but never enforces anything.
 * - Wake by @mention, saying "Nayla", or replying to one of its own messages
 * - Rolling ~50-message group conversation memory for AI context, archived to MongoDB at cap
 * - Commands: .rank/.level, .stats, .lock/.unlock, .mood, .kick, .promote/.demote, .tagall,
 *   .del, .help/.menu, .about, .owner
 * - ZERO-PAIRING startup flow: Loads authenticated session from MongoDB Atlas securely!
 * - 50+ Advanced Anti-Crash, Memory leak, Flood, and API Failure protection systems
 */

const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  delay 
} = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
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
    res.end("PONG - Nayla Keep-Alive is Active! 🌴😎\n");
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
  // FIX: RENDER_EXTERNAL_URL is always https:// in production, but the old
  // code always used the http module, which throws ERR_INVALID_PROTOCOL on
  // any https:// URL. This was crashing every 10 minutes (caught by the
  // uncaughtException trap, so the process survived) — meaning the self-ping
  // itself has never once actually succeeded since deployment.
  const client = SELF_URL.startsWith("https") ? https : http;
  setInterval(() => {
    client.get(SELF_URL, (res) => {
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
// FIX: previously these just logged and continued for EVERY error, including
// fatal WhatsApp socket/encryption failures ("Unsupported state or unable to
// authenticate data" — a corrupted noise-protocol/session state). Swallowing
// THAT specific class of error left the process technically running (still
// passing Render's health check) but with a dead underlying connection —
// messages would appear to send successfully in the logs while never
// actually reaching WhatsApp. A deliberate exit here lets Render restart
// with a completely fresh connection attempt; the session is safe in
// MongoDB, so nothing is lost. Every other error keeps the original
// "never crash" behavior — this only applies to this specific fatal pattern.
function isFatalConnectionError(errOrReason) {
  const msg = (errOrReason?.message || String(errOrReason) || "").toLowerCase();
  return msg.includes("unsupported state") || msg.includes("unable to authenticate data") || msg.includes("bad mac");
}

process.on("uncaughtException", (err) => {
  console.error("🔥 [ANTI-CRASH] Uncaught Exception trapped successfully:", err.message);
  console.error(err.stack);
  if (isFatalConnectionError(err)) {
    console.error("🔥 [ANTI-CRASH] Fatal WhatsApp connection/encryption error — exiting so Render restarts with a fresh connection (session is safe in MongoDB).");
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 [ANTI-CRASH] Unhandled Promise Rejection trapped successfully:", reason);
  if (isFatalConnectionError(reason)) {
    console.error("🔥 [ANTI-CRASH] Fatal WhatsApp connection/encryption error — exiting so Render restarts with a fresh connection (session is safe in MongoDB).");
    process.exit(1);
  }
});

// --- PROTECTION TIER 2: LOCAL HIGH-SPEED REGEX FALLBACK ENGINE (ZERO-LATENCY / NO COSTS) ---
const LOCAL_BAD_WORDS = [
  "scam", "crypto double", "giveaway free", "make money quick", "fuck", "bitch", "asshole", 
  "retard", "idiot", "motherfucker", "bastard", "dickhead", "pussy"
];

// Cheap, local, zero-AI-cost detectors — reused for both the local fallback
// AND as hints fed into the AI so it knows what's in a message without
// having to figure it out itself. Detection only; NONE of these delete or
// block anything anymore per your explicit instruction — the bot only ever
// comments on what it notices, in-character, never enforces.
function detectLink(text) {
  const linkRegex = /(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
  return linkRegex.test(text);
}
function detectGibberish(text) {
  const repeatingCharRegex = /(.)\1{15,}/i;
  const letters = text.replace(/[^a-zA-Z]/g, "");
  const isShouting = letters.length >= 12 && letters === letters.toUpperCase();
  const emojiFlood = (text.match(/\p{Extended_Pictographic}/gu) || []).length >= 10;
  // NOTE: deliberately does NOT flag on sheer length anymore — a long,
  // coherent message (someone sharing a story, pasting an article) isn't
  // gibberish just for being long, and it shouldn't get a "keyboard
  // smashing" comment. Only actual gibberish patterns count.
  return repeatingCharRegex.test(text) || isShouting || emojiFlood;
}
function detectLocalToxicity(text) {
  const textLower = text.toLowerCase();
  return LOCAL_BAD_WORDS.some(w => textLower.includes(w));
}

const GIBBERISH_COMMENTS = [
  "Seems like someone's smashing their keyboard 😭",
  "I felt that keyboard rage from here 💀",
  "Understood absolutely none of that, but I respect the energy",
  "That's a whole lot of nothing, but go off 😂"
];

// Unknown-command replies are now AI-generated (see generateUnknownCommandReply
// further below) instead of a fixed canned array, per request.

// NEVER deletes or formally warns — used only when Groq/Cerebras/Mistral are
// all unavailable, so the bot can still occasionally comment on something
// notable without needing any AI call. Links are deliberately NOT commented
// on here anymore (removed the canned LINK_COMMENTS array) — a link's
// commentary needs to actually react to what it's about, which requires the
// AI; a canned line risked landing rude/judgmental with zero context, and
// staying quiet is better than that when no AI is available to do it well.
function fallbackLocalModerate(text) {
  if (detectGibberish(text) && Math.random() < 0.35) {
    return { comment: GIBBERISH_COMMENTS[Math.floor(Math.random() * GIBBERISH_COMMENTS.length)], reaction: "" };
  }
  return { comment: "", reaction: "" };
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
const MAX_CONCURRENT_AI_WORKERS = 3; // was 1 — overly conservative now that every provider call has its own timeout + automatic failover; single-threading this just creates an unnecessary backlog when one provider is slow/failing
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

// --- DM-specific anti-spam: the EXACT same message sent 3x in a row ---
// Different from the flood limiter above (which only cares about frequency,
// not content) — this catches someone rapid-firing an identical message,
// which is pure wasted AI spend since the reply would be near-identical
// every time anyway. Scoped to DMs only, per spec.
const dmDuplicateTracker = new Map(); // senderJid -> { lastText, count, cooldownUntil }
const DUPLICATE_SPAM_THRESHOLD = 3;
const DUPLICATE_SPAM_COOLDOWN_MS = 5 * 60 * 1000;

function checkDuplicateSpam(senderJid, text) {
  const now = Date.now();
  const entry = dmDuplicateTracker.get(senderJid);

  if (entry?.cooldownUntil > now) {
    // FIX: previously blocked EVERY message for the full 5 minutes once
    // triggered, even ones with completely different text — punishing
    // someone for having sent duplicates once, indefinitely, regardless of
    // what they said next. A genuinely different message means the actual
    // spam (repetition) has stopped, so let it through right away instead.
    if (entry.lastText !== text) {
      entry.cooldownUntil = 0;
      entry.lastText = text;
      entry.count = 1;
      return "ok";
    }
    return "blocked";
  }

  if (entry && entry.lastText === text) {
    entry.count++;
    if (entry.count >= DUPLICATE_SPAM_THRESHOLD) {
      entry.cooldownUntil = now + DUPLICATE_SPAM_COOLDOWN_MS;
      entry.count = 0;
      return "just_triggered"; // this is the message that tipped it over — worth one notice
    }
    return "ok";
  }

  dmDuplicateTracker.set(senderJid, { lastText: text, count: 1, cooldownUntil: 0 });
  return "ok";
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
    lastAIReplyTime.clear();
    recentJoins.clear();
    recentRudenessFlag.clear();
    lastReactionTime.clear();
    lastAmbientTime.clear();
    lastEasterEggTime.clear();
    providerCooldowns.clear();
    dmDuplicateTracker.clear();
    chatEmojiHistory.clear();
    shutUpStrikes.clear();
    temporaryIgnore.clear();
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
    // FIX: same LID root cause as isBotMentioned — the old code only ever
    // constructed the phone-JID form (...@s.whatsapp.net). In any group
    // where WhatsApp represents the bot's OWN participant entry via its LID
    // instead, that never matched, so the bot always looked like a non-admin
    // even when it genuinely was one.
    const selfNumbers = [sock.user?.id, sock.user?.lid]
      .filter(Boolean)
      .map(j => j.split(":")[0].split("@")[0]);

    const botParticipant = groupMetadata.participants.find(p => {
      const num = p.id.split(":")[0].split("@")[0];
      return selfNumbers.includes(num);
    });
    const isAdmin = !!(botParticipant && (botParticipant.admin === "admin" || botParticipant.admin === "superadmin"));
    
    adminCache.set(jid, { timestamp: Date.now(), isAdmin });
    return isAdmin;
  } catch (err) {
    console.warn("⚠️ Failed fetching group metadata for admin validation:", err.message);
    return false;
  }
}

// ==========================================
// 🎉 TIER 8: GAMIFICATION & FUN-FEATURE STATE
// ==========================================
// Everything here is capped/bounded and flushed to Mongo periodically rather
// than on every message, keeping both RAM and Mongo write-load negligible on
// a personal-scale bot. None of this adds extra Groq requests except Movie
// Mode, which is capped to one call per group per day.
const userStatsCache = new Map();      // jid -> { displayName, xp, messageCount, facts, lastActive, dirty }
const groupMessageBuffers = new Map(); // groupJid -> [{sender, text, ts}], capped to ACTIVE_CONTEXT_CAP
const groupConfigCache = new Map();    // groupJid -> { locked, lastRecapDate, dirty }
const lastAIReplyTime = new Map();     // chatJid -> timestamp, for the reply cooldown
const recentJoins = new Map();         // groupJid -> [{ts, count}], for raid detection
let currentSock = null;                // set once startBot() creates a socket; read by top-level intervals
let statsLoadedOnce = false;

const ACTIVE_CONTEXT_CAP = 50;      // per your spec: ~50 messages of active memory, then archive+reset
const AI_REPLY_COOLDOWN_MS = 4000;  // stops rapid re-tags from burning the AI provider chain's quota
// Hard cap on how much of any single message ever reaches an AI provider —
// DM or group. A deliberately huge paste was confirmed to trip a real
// provider-side rate limit for 50+ minutes; nothing in this file was holding
// it that long, the provider was. Truncating before the call is the actual
// fix, not a longer local cooldown.
const MAX_AI_INPUT_CHARS = 4000;
// Separate, smaller cap specifically for quoted-message text injected into a
// NORMAL chat reply (not the dedicated summarize path, which has its own
// larger MAX_SUMMARIZABLE_CHARS) — this stacks on top of the question and
// recent-context transcript already in the same prompt, so it needs to stay
// modest to keep the total payload safely under every provider's limits.
const MAX_QUOTED_CONTEXT_CHARS = 1200;
const RAID_JOIN_THRESHOLD = 5;      // N joins...
const RAID_WINDOW_MS = 60000;       // ...within this many ms triggers an auto-lockdown

// --- Lightweight "human touches" state — every Map here is one small entry
// per ACTIVE chat, self-expiring via timestamp comparison, never grown
// unboundedly. No new Groq calls for any of this.
const recentRudenessFlag = new Map();  // chatJid -> expiresAt; briefly colors chat tone after a warn
const RUDENESS_MOOD_DURATION_MS = 10 * 60 * 1000; // 10 minutes, per spec
const lastReactionTime = new Map();    // chatJid -> ts, throttles emoji reactions
const REACTION_COOLDOWN_MS = 3 * 60 * 1000;
const lastAmbientTime = new Map();     // chatJid -> ts, throttles "Group Soul" asides
const AMBIENT_COOLDOWN_MS = 8 * 60 * 1000;
const lastEasterEggTime = new Map();   // chatJid -> ts, keeps these rare
const EASTER_EGG_COOLDOWN_MS = 6 * 60 * 60 * 1000; // at most once per 6h per chat
const EASTER_EGG_CHANCE = 0.01;        // 1% roll per eligible message, on top of the cooldown
const FAKE_BUG_LINES = ["🤖 Error 403: exploding earth in 20 seconds...", "Wait...", "Never mind. I'm okay 😅"];
const MYSTERY_EVENT_LINES = [
  "👀 Someone here is thinking about food right now. I won't say who.",
  "🔮 I sense someone's about to double-text.",
  "🎲 Random thought: someone in this chat owes someone else a reply."
];

const LEVEL_TITLES = [
  { level: 0, title: "Newcomer" },
  { level: 3, title: "Regular" },
  { level: 6, title: "Certified Menace" },
  { level: 10, title: "Village Elder" },
  { level: 15, title: "Professor" },
  { level: 20, title: "Chaos God" }
];

function xpToLevel(xp) {
  return Math.floor(Math.sqrt(xp / 10));
}

function levelTitle(level) {
  let title = LEVEL_TITLES[0].title;
  for (const t of LEVEL_TITLES) {
    if (level >= t.level) title = t.title;
  }
  return title;
}

const FACT_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getUserStats(jid) {
  if (!userStatsCache.has(jid)) {
    userStatsCache.set(jid, { displayName: "Anonymous", xp: 0, messageCount: 0, lastActive: new Date(), dirty: true });
  }
  return userStatsCache.get(jid);
}

function bumpUserStats(jid, displayName) {
  const stats = getUserStats(jid);
  stats.displayName = displayName || stats.displayName;
  stats.xp += 1 + Math.floor(Math.random() * 3); // +1 to +3 XP per message
  stats.messageCount += 1;
  stats.lastActive = new Date();
  stats.dirty = true;
  return stats;
}

// --- Per-chat personal facts (PRIVACY FIX: this used to live on UserStat,
// keyed only by person — meaning something discussed in a DM leaked into an
// unrelated group chat, since the SAME facts array was read regardless of
// which conversation was active. Now scoped to the specific chat a fact was
// learned in: "chatJid|senderJid" — a DM and every group are separate
// memory spaces for the same person, exactly as requested. Still expires
// after 30 days of inactivity in that specific chat, same as before.
const userFactsCache = new Map();

function factsCacheKey(chatJid, senderJid) {
  return `${chatJid}|${senderJid}`;
}

function getUserFacts(chatJid, senderJid) {
  const key = factsCacheKey(chatJid, senderJid);
  if (!userFactsCache.has(key)) {
    userFactsCache.set(key, { facts: [], lastActive: new Date(), dirty: true });
  }
  const entry = userFactsCache.get(key);
  if (entry.facts.length > 0 && entry.lastActive && (Date.now() - new Date(entry.lastActive).getTime() > FACT_MEMORY_TTL_MS)) {
    entry.facts = [];
    entry.dirty = true;
  }
  return entry;
}

function addUserFactScoped(chatJid, senderJid, fact) {
  if (!fact || !fact.trim()) return;
  const entry = getUserFacts(chatJid, senderJid);
  const clean = fact.trim().slice(0, 120);
  if (entry.facts.includes(clean)) return;
  entry.facts.push(clean);
  if (entry.facts.length > 5) entry.facts.shift(); // cap to last 5 — bounds both memory and prompt size
  entry.lastActive = new Date();
  entry.dirty = true;
}

// Batch-flush ONLY changed user stats to Mongo periodically — avoids a write
// on every single message, which would hammer the free Mongo tier for data
// this low-stakes (XP, not moderation state).
async function flushUserStatsToMongo() {
  if (!MONGO_URI) return;
  const dirtyEntries = [...userStatsCache.entries()].filter(([, s]) => s.dirty);
  if (dirtyEntries.length === 0) return;

  for (const [jid, stats] of dirtyEntries) {
    try {
      await UserStat.findOneAndUpdate(
        { jid },
        { displayName: stats.displayName, xp: stats.xp, messageCount: stats.messageCount, lastActive: stats.lastActive },
        { upsert: true }
      );
      stats.dirty = false;
    } catch (err) {
      console.error(`❌ Failed flushing stats for ${jid}:`, err.message);
    }
  }
  console.log(`💾 [STATS] Flushed ${dirtyEntries.length} updated user profile(s) to MongoDB.`);
}

async function flushUserFactsToMongo() {
  if (!MONGO_URI) return;
  const dirtyEntries = [...userFactsCache.entries()].filter(([, e]) => e.dirty);
  if (dirtyEntries.length === 0) return;

  for (const [key, entry] of dirtyEntries) {
    const [chatJid, senderJid] = key.split("|");
    try {
      await UserChatFacts.findOneAndUpdate(
        { chatJid, jid: senderJid },
        { facts: entry.facts, lastActive: entry.lastActive },
        { upsert: true }
      );
      entry.dirty = false;
    } catch (err) {
      console.error(`❌ Failed flushing per-chat facts for ${key}:`, err.message);
    }
  }
  console.log(`💾 [FACTS] Flushed ${dirtyEntries.length} updated per-chat fact set(s) to MongoDB.`);
}

async function loadUserStatsFromMongo() {
  if (!MONGO_URI) return;
  try {
    const all = await UserStat.find({}).limit(2000); // hard cap — plenty for a personal-scale bot
    for (const doc of all) {
      userStatsCache.set(doc.jid, {
        displayName: doc.displayName || "Anonymous",
        xp: doc.xp || 0,
        messageCount: doc.messageCount || 0,
        lastActive: doc.lastActive || new Date(),
        dirty: false
      });
    }
    console.log(`📥 [STATS] Loaded ${all.length} existing user profile(s) from MongoDB.`);
  } catch (err) {
    console.error("❌ Failed loading user stats from MongoDB:", err.message);
  }
}

async function loadUserFactsFromMongo() {
  if (!MONGO_URI) return;
  try {
    const all = await UserChatFacts.find({}).limit(5000);
    for (const doc of all) {
      userFactsCache.set(factsCacheKey(doc.chatJid, doc.jid), {
        facts: doc.facts || [],
        lastActive: doc.lastActive || new Date(),
        dirty: false
      });
    }
    console.log(`📥 [FACTS] Loaded ${all.length} existing per-chat fact set(s) from MongoDB.`);
  } catch (err) {
    console.error("❌ Failed loading per-chat facts from MongoDB:", err.message);
  }
}

function getGroupConfig(jid) {
  if (!groupConfigCache.has(jid)) {
    // messagesReceived/responsesSent are session-only counters for .settings
    // — deliberately NOT written to Mongo (would mean a DB write on every
    // single message, which is exactly the kind of cost this bot avoids
    // everywhere else). They reset on restart, same trade-off .stats/.health
    // already make with uptime.
    groupConfigCache.set(jid, { locked: false, lastRecapDate: null, mood: "cool", muted: false, ignoredUsers: [], messagesReceived: 0, responsesSent: 0, sessionStart: Date.now(), dirty: false });
  }
  return groupConfigCache.get(jid);
}

async function persistGroupConfig(jid) {
  if (!MONGO_URI) return;
  const cfg = getGroupConfig(jid);
  try {
    await GroupConfig.findOneAndUpdate(
      { jid },
      { locked: cfg.locked, lastRecapDate: cfg.lastRecapDate, mood: cfg.mood, muted: cfg.muted, ignoredUsers: cfg.ignoredUsers },
      { upsert: true }
    );
  } catch (err) {
    console.error(`❌ Failed persisting group config for ${jid}:`, err.message);
  }
}

async function loadGroupConfigsFromMongo() {
  if (!MONGO_URI) return;
  try {
    const all = await GroupConfig.find({}).limit(500);
    for (const doc of all) {
      groupConfigCache.set(doc.jid, { locked: !!doc.locked, lastRecapDate: doc.lastRecapDate || null, mood: doc.mood || "cool", muted: !!doc.muted, ignoredUsers: doc.ignoredUsers || [], dirty: false });
    }
    console.log(`📥 [CONFIG] Loaded ${all.length} existing group config(s) from MongoDB.`);
  } catch (err) {
    console.error("❌ Failed loading group configs from MongoDB:", err.message);
  }
}

// Active conversational memory: holds the last ACTIVE_CONTEXT_CAP text
// messages per group. Feeds AI chat replies with real context AND doubles as
// Movie Mode's source. Once it hits the cap, the whole buffer is archived to
// MongoDB (a durable "dump") and reset — bounded memory, nothing silently
// lost, and the AI always has a fresh, relevant window instead of stale
// months-old context.
async function bufferGroupMessage(jid, sender, text) {
  if (!groupMessageBuffers.has(jid)) groupMessageBuffers.set(jid, []);
  const buf = groupMessageBuffers.get(jid);
  buf.push({ sender, text: text.slice(0, 200), ts: Date.now() }); // truncate per-message to bound memory

  if (buf.length >= ACTIVE_CONTEXT_CAP) {
    if (MONGO_URI) {
      try {
        await ConversationArchive.create({
          jid,
          transcript: buf.map(m => `${m.sender}: ${m.text}`),
          archivedAt: new Date()
        });
        console.log(`🗄️ [MEMORY] Archived ${buf.length} messages for ${jid} to MongoDB — active context reset.`);
      } catch (err) {
        console.error(`❌ Failed archiving conversation for ${jid}:`, err.message);
        // Fall through and reset anyway — bounding memory matters more than
        // this one archive succeeding.
      }
    }
    groupMessageBuffers.set(jid, []); // reset for a fresh window regardless of archive success
  }
}

// Returns the last `limit` buffered messages as a mini-transcript, capped
// hard regardless of how much is stored, to keep every AI prompt small and
// fast rather than growing with group activity.
function getRecentContext(jid, limit = 15) {
  const buf = groupMessageBuffers.get(jid) || [];
  if (buf.length === 0) return "";
  const transcript = buf.slice(-limit).map(m => `${m.sender}: ${m.text}`).join("\n");
  return transcript.slice(-3000); // defensive hard cap regardless of message count/length changes elsewhere
}

// --- 🎬 Movie Mode: ONE AI call per group per day, never per-message ---
async function maybeGenerateMovieRecap(sock) {
  if (!sock || PROVIDER_CHAIN.length === 0) return;
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  for (const [jid, buffer] of groupMessageBuffers.entries()) {
    if (!jid.endsWith("@g.us")) continue; // DMs now share this buffer for context memory — never recap a private chat
    try {
      const cfg = getGroupConfig(jid);
      if (cfg.lastRecapDate === today) continue; // already recapped today
      if (buffer.length < 15) continue; // not enough activity to bother

      const transcript = buffer.map(m => `${m.sender}: ${m.text}`).join("\n").slice(0, 6000); // token-bound

      const raw = await callAIProvider([
        { role: "system", content: `You write short, funny "episode recap" summaries of WhatsApp group chat days, like a sitcom recap. Punchy, 4-6 sentences max, playful, uses the real names mentioned. End with a one-line "Episode Rating: X/10" and a couple of emoji.` },
        { role: "user", content: `Here is today's group chat transcript:\n${transcript}\n\nWrite today's cinematic recap.` }
      ], { json: false, temperature: 0.9, timeoutMs: 15000 });

      const recap = raw.trim();
      await sock.sendMessage(jid, { text: `🎬 *Today's Episode*\n\n${recap}` });
      console.log(`🎬 [MOVIE MODE] Sent daily recap to ${jid}.`);

      cfg.lastRecapDate = today;
      cfg.dirty = true;
      await persistGroupConfig(jid);
      groupMessageBuffers.set(jid, []); // reset for the new day
    } catch (err) {
      const { category, detail } = describeAIError(err);
      console.error(`🔴 [MOVIE MODE FAILURE] ${jid} | Category: ${category} | ${detail}`);
      // Never let one group's failure stop the loop for the rest.
    }
  }
}

// --- 🚨 Raid protection: mass-join detection, zero AI cost ---
// group-participants.update fires with a whole participants[] array per
// event (can be a batch add), so joins are weighted by array length rather
// than counted as 1 per event.
async function checkRaidProtection(sock, jid, joinCount = 1) {
  const now = Date.now();
  if (!recentJoins.has(jid)) recentJoins.set(jid, []);
  const joins = recentJoins.get(jid).filter(j => now - j.ts < RAID_WINDOW_MS);
  joins.push({ ts: now, count: joinCount });
  recentJoins.set(jid, joins);

  const totalJoins = joins.reduce((sum, j) => sum + j.count, 0);
  if (totalJoins < RAID_JOIN_THRESHOLD) return;

  console.warn(`🚨 [RAID PROTECTION] ${totalJoins} joins in <60s in ${jid}. Attempting auto-lockdown...`);
  recentJoins.set(jid, []); // reset so this doesn't re-trigger on every subsequent join

  try {
    const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
    if (isBotAdmin) {
      await sock.groupSettingUpdate(jid, "announcement"); // admin-only messaging
      await sock.sendMessage(jid, { text: `🚨 Raid protection triggered: ${totalJoins} joins in under a minute. Group locked to admins-only. An admin can send *.unlock* to reopen.` });
      const cfg = getGroupConfig(jid);
      cfg.locked = true;
      cfg.dirty = true;
      await persistGroupConfig(jid);
    } else {
      await sock.sendMessage(jid, { text: `🚨 Raid protection triggered: ${totalJoins} joins in under a minute — but I'm not an admin here, so I can't auto-lock. Please check the group manually!` });
    }
  } catch (err) {
    console.error("❌ Raid protection lockdown failed:", err.message);
  }
}

// --- Command router for . commands (.rank, .stats, .lock, .unlock) ---
async function checkIfSenderIsAdmin(sock, jid, senderJid) {
  try {
    const groupMetadata = await sock.groupMetadata(jid);
    const senderNumber = senderJid.split(":")[0].split("@")[0];
    const participant = groupMetadata.participants.find(p => {
      const idNum = p.id?.split(":")[0].split("@")[0];
      const lidNum = p.lid?.split(":")[0].split("@")[0];
      return idNum === senderNumber || lidNum === senderNumber;
    });
    return !!(participant && (participant.admin === "admin" || participant.admin === "superadmin"));
  } catch (err) {
    console.warn("⚠️ Failed checking sender admin status:", err.message);
    return false;
  }
}

// Returns true if the text was a recognized command (caller should skip
// further moderation/AI-chat processing for this message).
async function handleCommand(sock, jid, senderJid, sender, text, msg) {
  const cmd = text.toLowerCase().trim();
  if (!cmd.startsWith(".")) return false;

  try {
    if (cmd === ".rank" || cmd === ".level") {
      const stats = getUserStats(senderJid);
      const level = xpToLevel(stats.xp);
      await sock.sendMessage(jid, {
        text: `📈 *${sender}'s Rank*\nLevel ${level} — "${levelTitle(level)}"\nXP: ${stats.xp} | Messages: ${stats.messageCount}`
      }, { quoted: msg });
      return true;
    }

    if (cmd === ".stats") {
      const mem = process.memoryUsage();
      const uptimeMin = (process.uptime() / 60).toFixed(1);
      await sock.sendMessage(jid, {
        text: `📊 *Nayla Status*\nUptime: ${uptimeMin} min\nHeap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB / 512 MB\nAI failures (streak): ${aiFailStreak}\nCircuit breaker: ${circuitBreakerOpen ? "OPEN (using local fallback)" : "closed (AI healthy)"}\nTracked users: ${userStatsCache.size}\nTracked groups: ${groupMessageBuffers.size}`
      }, { quoted: msg });
      return true;
    }

    if (cmd === ".health") {
      const mem = process.memoryUsage();
      const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

      const mongoState = mongoose.connection.readyState; // 0=disconnected,1=connected,2=connecting,3=disconnecting
      const mongoStatus = mongoState === 1 ? "🟢 Connected" : mongoState === 2 ? "🟡 Connecting" : mongoState === 3 ? "🟡 Disconnecting" : "🔴 Disconnected";

      // MongoDB storage usage — uses the native driver's db.stats() command,
      // which is part of any standard connection (no extra Atlas API/creds
      // needed). Wrapped in try/catch since this is diagnostics-only — a
      // failure here should never break the rest of .health.
      let storageText = "unavailable";
      if (mongoState === 1) {
        try {
          const stats = await mongoose.connection.db.stats();
          const usedMB = (stats.dataSize / 1024 / 1024).toFixed(1);
          storageText = `${usedMB} MB used (M0 tier caps around 512 MB)`;
        } catch (e) { /* leave as "unavailable" */ }
      }

      const providerNames = PROVIDER_CHAIN.map(p => p.name);
      const providerList = providerNames.length > 0 ? providerNames.join(" → ") : "🔴 None configured (running on local fallback only)";

      const healthText = `🏥 *${BOT_CONFIG.name} System Health*\n\n` +
        `*🧠 AI Engine:*\nChain: ${providerList}\nFail streak: ${aiFailStreak}/3\nCircuit breaker: ${circuitBreakerOpen ? "🔴 OPEN (using local fallback)" : "🟢 CLOSED (healthy)"}\n\n` +
        `*🔎 Extras:*\nWeb search: ${TAVILY_KEYS.length > 0 ? `🟢 ${TAVILY_KEYS.length} key(s)` : "🔴 not configured"}\nImage generation: 🟢 always available (no key needed)\nVision: ${GEMINI_VISION_KEYS.length > 0 ? "🟢 available" : "🔴 not configured"}\nVoice transcription: ${collectProviderKeys("GROQ_API_KEY").length > 0 ? "🟢 available" : "🔴 not configured"}\nHeavy task load: ${activeHeavyTasks}/${MAX_CONCURRENT_HEAVY_TASKS} running, ${heavyTaskQueue.length} queued\n\n` +
        `*💾 Database & Memory:*\nMongoDB: ${mongoStatus}\nStorage used: ${storageText}\nRAM: ${mb(mem.heapUsed)} MB / 512 MB\nTracked users: ${userStatsCache.size}\nActive groups: ${groupMessageBuffers.size}\n\n` +
        `*⚙️ Process:*\nUptime: ${(process.uptime() / 60).toFixed(1)} min\nQueue depth: ${apiRequestQueue.length}`;

      await sock.sendMessage(jid, { text: healthText }, { quoted: msg });
      return true;
    }

    if (cmd === ".settings") {
      if (!jid.endsWith("@g.us")) {
        await sock.sendMessage(jid, { text: "⚠️ That command only works in groups." }, { quoted: msg });
        return true;
      }
      const cfg = getGroupConfig(jid);
      const sessionMin = ((Date.now() - cfg.sessionStart) / 60000).toFixed(1);
      const settingsText = `⚙️ *Settings for this group*\n\n` +
        `Muted: ${cfg.muted ? "🔇 Yes (only *.unmute* works)" : "🔊 No"}\n` +
        `Mood: *${cfg.mood}*\n` +
        `Locked (admin-only messaging): ${cfg.locked ? "🔒 Yes" : "🔓 No"}\n` +
        `Ignored users: ${cfg.ignoredUsers.length}\n\n` +
        `📊 *This session* (resets on bot restart):\n` +
        `Messages received: ${cfg.messagesReceived}\n` +
        `Responses sent: ${cfg.responsesSent}\n` +
        `Tracking for: ${sessionMin} min`;
      await sock.sendMessage(jid, { text: settingsText }, { quoted: msg });
      return true;
    }

    if (cmd === ".lock" || cmd === ".unlock") {
      if (!jid.endsWith("@g.us")) {
        await sock.sendMessage(jid, { text: "⚠️ That command only works in groups." }, { quoted: msg });
        return true;
      }
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
      if (!isBotAdmin) {
        await sock.sendMessage(jid, { text: "⚠️ I need to be a group admin to lock/unlock the group." }, { quoted: msg });
        return true;
      }
      const locking = cmd === ".lock";
      await sock.groupSettingUpdate(jid, locking ? "announcement" : "not_announcement");
      const cfg = getGroupConfig(jid);
      cfg.locked = locking;
      cfg.dirty = true;
      await persistGroupConfig(jid);
      await sock.sendMessage(jid, { text: locking ? "🔒 Group locked — only admins can send messages now." : "🔓 Group unlocked — everyone can send messages again." });
      return true;
    }

    if (cmd === ".mood" || cmd.startsWith(".mood ")) {
      const parts = text.trim().split(/\s+/);
      if (!jid.endsWith("@g.us")) {
        await sock.sendMessage(jid, { text: `🎭 Available moods: ${AVAILABLE_MOODS.join(", ")}\n(Mood is set per-group — this only applies inside groups.)` }, { quoted: msg });
        return true;
      }
      const cfg = getGroupConfig(jid);
      if (parts.length === 1) {
        await sock.sendMessage(jid, { text: `🎭 Current mood here: *${cfg.mood}*\nAvailable: ${AVAILABLE_MOODS.join(", ")}\nAdmins can change it: *.mood <name>*` }, { quoted: msg });
        return true;
      }
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can change the mood." }, { quoted: msg });
        return true;
      }
      const newMood = parts[1].toLowerCase();
      if (!AVAILABLE_MOODS.includes(newMood)) {
        await sock.sendMessage(jid, { text: `❌ Unknown mood. Available: ${AVAILABLE_MOODS.join(", ")}` }, { quoted: msg });
        return true;
      }
      cfg.mood = newMood;
      cfg.dirty = true;
      await persistGroupConfig(jid);
      await sock.sendMessage(jid, { text: `🎭 Mood changed to *${newMood}*!` });
      console.log(`🎭 [MOOD] ${jid} mood changed to "${newMood}" by ${sender}.`);
      return true;
    }

    if (cmd === ".help" || cmd === ".menu") {
      await sock.sendMessage(jid, {
        text: `🤖 *${BOT_CONFIG.name} Commands*\n\n*Everyone:*\n.rank / .level — your XP & title\n.stats — bot health\n.health — full system diagnostics\n.mood — show current personality\n.about — what I am\n.owner — who made me\n.search <query> — I'll look it up on the web\n.imagine <prompt> — I'll generate an image\n.ping / .flip / .roll [sides] / .8ball — quick fun stuff\n\n*Group admins only:*\n.settings — this group's status (mute, mood, message counts)\n.lock / .unlock — restrict messaging to admins\n.mood <name> — change personality (${AVAILABLE_MOODS.join(", ")})\n.kick (reply or @mention) — remove a member\n.promote / .demote (reply or @mention) — admin toggle\n.tagall — mention everyone\n.del (reply to a message) — delete it\n.mute / .unmute — I go completely silent in this group until unmuted\n.ignore (reply or @mention) — I stop responding to that one person here\n.ignorelist / .undoignore (@user or "all") — manage the ignore list\n\nTag me or say my name to chat — send me a photo/sticker/voice note directly and I'll understand it too! Heads up: I'm a vibe bot, not a moderator — I don't delete stuff or hand out formal warnings, ever.`
      }, { quoted: msg });
      return true;
    }

    if (cmd === ".about") {
      await sock.sendMessage(jid, {
        text: `🤖 *About ${BOT_CONFIG.name}*\n\nI'm a WhatsApp companion bot — I chat, vibe, remember little things about you, search the web, look at photos/stickers, listen to voice notes, and generate images. I do NOT delete messages or moderate anything; I'm just here for the energy.\n\nUnder the hood: Baileys for WhatsApp, a chain of AI providers (with automatic backups if one's busy), and MongoDB for memory — all running on a cloud server my creator pays for, so be nice to them.\n\nType *.owner* to see who that is, or *.help* for what I can do.`
      }, { quoted: msg });
      return true;
    }

    if (cmd === ".owner") {
      await sock.sendMessage(jid, {
        text: `👑 My creator and owner is *${BOT_CONFIG.creator}*. They built me, they host me, they keep the lights on — direct all compliments (and bug reports) their way 😎`
      }, { quoted: msg });
      return true;
    }

    const kickPromoDemoteMatch = [".kick", ".promote", ".demote"].find(base => cmd === base || cmd.startsWith(base + " "));
    if (jid.endsWith("@g.us") && kickPromoDemoteMatch) {
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
      if (!isBotAdmin) {
        await sock.sendMessage(jid, { text: "⚠️ I need to be a group admin to do that." }, { quoted: msg });
        return true;
      }
      const target = resolveCommandTarget(msg.message);
      if (!target) {
        await sock.sendMessage(jid, { text: "⚠️ Reply to that person's message, or @mention them, along with the command." }, { quoted: msg });
        return true;
      }
      const actionMap = { ".kick": "remove", ".promote": "promote", ".demote": "demote" };
      await sock.groupParticipantsUpdate(jid, [target], actionMap[kickPromoDemoteMatch]);
      const label = { ".kick": "removed 👋", ".promote": "promoted to admin 🎖️", ".demote": "demoted from admin" }[kickPromoDemoteMatch];
      await sock.sendMessage(jid, { text: `✅ @${target.split("@")[0]} ${label}.`, mentions: [target] });
      console.log(`✅ [${kickPromoDemoteMatch}] ${sender} used ${kickPromoDemoteMatch} on ${target} in ${jid}.`);
      return true;
    }

    if (jid.endsWith("@g.us") && (cmd === ".mute" || cmd === ".unmute")) {
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const cfg = getGroupConfig(jid);
      if (cmd === ".mute") {
        cfg.muted = true;
        cfg.dirty = true;
        await persistGroupConfig(jid);
        await sock.sendMessage(jid, { text: "😴 Going quiet — I won't react, comment, or reply to anything here until *.unmute*." }, { quoted: msg });
      } else {
        cfg.muted = false;
        cfg.dirty = true;
        await persistGroupConfig(jid);
        const wakeLines = [
          "It's been forever, I've been sleeping 😴 I'm back now!! What did I miss?",
          "I've been secretly observing everyone this whole time 👀 I'm back now!",
          "*yawns* Okay okay I'm up, I'm up. What's going on in here?",
          "Rise and shine, it's me again! Catch me up?",
          "Woke up from the longest nap ever. So... what happened?",
          "I'm back online! Pretend I never left 😎"
        ];
        await sock.sendMessage(jid, { text: wakeLines[Math.floor(Math.random() * wakeLines.length)] }, { quoted: msg });
      }
      return true;
    }

    if (jid.endsWith("@g.us") && (cmd === ".ignore" || cmd.startsWith(".ignore "))) {
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const target = resolveCommandTarget(msg.message);
      if (!target) {
        await sock.sendMessage(jid, { text: "⚠️ Reply to that person's message, or @mention them, along with *.ignore*." }, { quoted: msg });
        return true;
      }
      // FIX (confirmed bug): replying to one of the BOT's own messages and
      // typing ".ignore" with no other target resolves via contextInfo.
      // participant — which is whoever sent the quoted message, i.e. the
      // bot itself. That's how it ended up claiming to ignore itself.
      if (isSelfJid(sock, target)) {
        await sock.sendMessage(jid, { text: "🤣 I can't ignore myself, that's not how this works — reply to or @mention the PERSON you want ignored." }, { quoted: msg });
        return true;
      }
      const cfg = getGroupConfig(jid);
      if (!isJidInList(cfg.ignoredUsers, target)) cfg.ignoredUsers.push(target);
      cfg.dirty = true;
      await persistGroupConfig(jid);
      await sock.sendMessage(jid, { text: `🔇 Ignoring @${target.split("@")[0]} in this group from now on — no replies, no reactions, nothing, until *.undoignore*.`, mentions: [target] });
      return true;
    }

    if (jid.endsWith("@g.us") && cmd === ".ignorelist") {
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const cfg = getGroupConfig(jid);
      if (cfg.ignoredUsers.length === 0) {
        await sock.sendMessage(jid, { text: "✅ Nobody's being ignored in this group right now." }, { quoted: msg });
      } else {
        await sock.sendMessage(jid, { text: `🔇 Currently ignoring:\n${cfg.ignoredUsers.map(u => "@" + u.split("@")[0]).join("\n")}`, mentions: cfg.ignoredUsers });
      }
      return true;
    }

    if (jid.endsWith("@g.us") && (cmd === ".undoignore" || cmd.startsWith(".undoignore "))) {
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const cfg = getGroupConfig(jid);
      const arg = cmd.slice(".undoignore".length).trim();
      if (arg === "all") {
        cfg.ignoredUsers = [];
      } else {
        const target = resolveCommandTarget(msg.message);
        if (!target) {
          await sock.sendMessage(jid, { text: "⚠️ Reply to/@mention someone, or use *.undoignore all*." }, { quoted: msg });
          return true;
        }
        const targetNum = target.split(":")[0].split("@")[0];
        cfg.ignoredUsers = cfg.ignoredUsers.filter(u => u.split(":")[0].split("@")[0] !== targetNum);
      }
      cfg.dirty = true;
      await persistGroupConfig(jid);
      await sock.sendMessage(jid, { text: "✅ Updated the ignore list." }, { quoted: msg });
      return true;
    }

    if (cmd === ".tagall" || cmd === ".everyone") {
      if (!jid.endsWith("@g.us")) {
        await sock.sendMessage(jid, { text: "⚠️ That command only works in groups." }, { quoted: msg });
        return true;
      }
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const groupMetadata = await sock.groupMetadata(jid);
      const allJids = groupMetadata.participants.map(p => p.id);
      await sock.sendMessage(jid, { text: "📢 Attention everyone!", mentions: allJids });
      return true;
    }

    if (cmd === ".search" || cmd.startsWith(".search ")) {
      const query = text.trim().slice(".search".length).trim();
      if (!query) {
        await sock.sendMessage(jid, { text: "🔎 Usage: *.search <what you want to know>*" }, { quoted: msg });
        return true;
      }
      if (TAVILY_KEYS.length === 0) {
        await sock.sendMessage(jid, { text: "🔎 Web search isn't set up yet — my developer needs to add TAVILY_API_KEY." }, { quoted: msg });
        return true;
      }
      await sock.sendMessage(jid, { text: randomFiller("search") }, { quoted: msg });
      try {
        const result = await runHeavyTask(() => searchWeb(query));
        if (result.success && result.results) {
          const vibe = jid.endsWith("@g.us") ? getGroupConfig(jid).mood : BOT_CONFIG.vibe;
          const summary = await generateAIChatReply(senderJid, sender, `Using these fresh web search results, answer clearly: ${query}\n\nResults:\n${result.results}`, vibe, "", null, false, "", jid);
          await sock.sendMessage(jid, { text: summary.message }, { quoted: msg });
        } else {
          await sock.sendMessage(jid, { text: "🔎 Couldn't find anything useful for that — try rephrasing?" }, { quoted: msg });
        }
      } catch (err) {
        const failText = err.message === "HEAVY_QUEUE_FULL"
          ? "😅 I'm pretty swamped right now — give me a minute and try that search again?"
          : "🔎 Something went wrong searching for that — try again?";
        await sock.sendMessage(jid, { text: failText }, { quoted: msg });
      }
      return true;
    }

    if (cmd === ".imagine" || cmd.startsWith(".imagine ")) {
      const prompt = text.trim().slice(".imagine".length).trim();
      if (!prompt) {
        await sock.sendMessage(jid, { text: "🎨 Usage: *.imagine <what you want to see>*" }, { quoted: msg });
        return true;
      }
      await sock.sendMessage(jid, { text: randomFiller("image") }, { quoted: msg });
      try {
        await runHeavyTask(async () => {
          const url = buildImagineUrl(prompt);
          // Baileys downloads/uploads the image itself from the URL — this
          // never touches our own RAM at all, the safest possible path.
          await sock.sendMessage(jid, { image: { url }, caption: `🎨 *${prompt}*` }, { quoted: msg });
        });
      } catch (err) {
        const failText = err.message === "HEAVY_QUEUE_FULL"
          ? "😅 I'm pretty swamped right now — give me a minute and try generating that again?"
          : "🎨 Something went wrong generating that image — try again, maybe with a simpler prompt?";
        await sock.sendMessage(jid, { text: failText }, { quoted: msg }).catch(() => {});
      }
      return true;
    }

    if (cmd === ".ping") {
      const start = Date.now();
      await sock.sendMessage(jid, { text: "🏓 Pong!" }, { quoted: msg });
      console.log(`🏓 [PING] Replied in ${Date.now() - start}ms.`);
      return true;
    }

    if (cmd === ".flip") {
      await sock.sendMessage(jid, { text: Math.random() < 0.5 ? "🪙 Heads!" : "🪙 Tails!" }, { quoted: msg });
      return true;
    }

    if (cmd === ".roll" || cmd.startsWith(".roll ")) {
      const sidesArg = parseInt(text.trim().split(/\s+/)[1], 10);
      const sides = Number.isFinite(sidesArg) && sidesArg >= 2 && sidesArg <= 1000 ? sidesArg : 6;
      const result = Math.floor(Math.random() * sides) + 1;
      await sock.sendMessage(jid, { text: `🎲 Rolled a d${sides}... *${result}*!` }, { quoted: msg });
      return true;
    }

    if (cmd === ".8ball" || cmd.startsWith(".8ball ")) {
      const answers = [
        "Yes, absolutely.", "No, and don't ask again.", "Ask me later 😴", "Very doubtful.",
        "Signs point to yes ✨", "Absolutely not.", "It is certain.", "Cannot predict that right now.",
        "Without a doubt.", "My sources say no."
      ];
      await sock.sendMessage(jid, { text: `🎱 ${answers[Math.floor(Math.random() * answers.length)]}` }, { quoted: msg });
      return true;
    }

    if (cmd === ".del" || cmd === ".delete") {
      if (!jid.endsWith("@g.us")) {
        await sock.sendMessage(jid, { text: "⚠️ That command only works in groups." }, { quoted: msg });
        return true;
      }
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
      if (!isBotAdmin) {
        await sock.sendMessage(jid, { text: "⚠️ I need to be a group admin to delete messages." }, { quoted: msg });
        return true;
      }
      const quotedKey = resolveQuotedMessageKey(jid, msg.message);
      if (!quotedKey) {
        await sock.sendMessage(jid, { text: "⚠️ Reply to the message you want deleted with *.del*." }, { quoted: msg });
        return true;
      }
      await sock.sendMessage(jid, { delete: quotedKey });
      console.log(`🗑️ [.del] ${sender} deleted a message in ${jid}.`);
      return true;
    }
  } catch (err) {
    console.error(`❌ Command "${cmd}" failed:`, err.message);
    try { await sock.sendMessage(jid, { text: "❌ That command failed — check my admin permissions and try again." }, { quoted: msg }); } catch (e) {}
    return true;
  }

  return false; // not a recognized command — fall through to normal handling
}

// Runs independent of connection state — checks every 10 min whether it's
// time for a Movie Mode recap, and flushes any dirty XP/fact changes to
// Mongo. Lives at module scope (not inside startBot()) so it's created
// exactly once regardless of how many times the socket reconnects.
setInterval(async () => {
  try {
    await flushUserStatsToMongo();
    await flushUserFactsToMongo();
    await maybeGenerateMovieRecap(currentSock);
  } catch (err) {
    console.error("❌ [SCHEDULER] Periodic gamification/movie-mode task failed:", err.message);
  }
}, 10 * 60 * 1000);

// 🔑 ROOT FIX for "Bad MAC" decryption errors: the ONLY thing that previously
// triggered a full session upload to MongoDB was the creds.update event —
// but that event fires only for the main identity blob. Baileys writes
// per-contact session/sender-key files directly to disk on every message
// exchange, completely independent of creds.update. That left MongoDB
// holding a STALE snapshot of the Signal Protocol session state; restoring
// that stale snapshot after any restart desynced the double-ratchet from
// what senders actually used to encrypt, which is exactly what a Bad MAC
// error means. This periodic full-folder sync bounds that staleness window
// to at most 60 seconds instead of however long since the last creds.update.
const AUTH_FOLDER_PATH = "./session_auth";
setInterval(async () => {
  try {
    if (fs.existsSync(AUTH_FOLDER_PATH)) {
      await uploadSessionToMongo(AUTH_FOLDER_PATH);
    }
  } catch (err) {
    console.error("❌ [SESSION SYNC] Periodic full-session sync failed:", err.message);
  }
}, 60 * 1000);

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

// --- Lightweight gamification & memory schemas (all best-effort, non-critical) ---
const UserStatSchema = new mongoose.Schema({
  jid: { type: String, required: true, unique: true },
  displayName: String,
  xp: { type: Number, default: 0 },
  messageCount: { type: Number, default: 0 },
  lastActive: Date
});
const UserStat = mongoose.models.UserStat || mongoose.model("UserStat", UserStatSchema);

// Per-chat personal facts — PRIVACY FIX, see getUserFacts() above. Each doc
// is one person's remembered facts within ONE specific chat (DM or a single
// group); the same person has a separate doc per chat they've talked to the
// bot in. TTL-indexed to auto-delete after 30 days of inactivity in that
// chat, matching the in-memory expiry — MongoDB handles it server-side.
const UserChatFactsSchema = new mongoose.Schema({
  jid: { type: String, required: true }, // the person
  chatJid: { type: String, required: true }, // which specific chat this was learned in
  facts: { type: [String], default: [] },
  lastActive: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
});
UserChatFactsSchema.index({ jid: 1, chatJid: 1 }, { unique: true });
const UserChatFacts = mongoose.models.UserChatFacts || mongoose.model("UserChatFacts", UserChatFactsSchema);

const GroupConfigSchema = new mongoose.Schema({
  jid: { type: String, required: true, unique: true },
  locked: { type: Boolean, default: false },
  lastRecapDate: String, // "YYYY-MM-DD" of the last Movie Mode recap sent
  mood: { type: String, default: "cool" }, // per-group personality override
  muted: { type: Boolean, default: false }, // .mute — bot ignores everything in this group
  ignoredUsers: { type: [String], default: [] } // .ignore — per-user JIDs the bot ignores in this group
});
const GroupConfig = mongoose.models.GroupConfig || mongoose.model("GroupConfig", GroupConfigSchema);

// Archived "active memory" dumps — written once a group's rolling 50-message
// buffer fills up, then the live buffer resets. Not meant to be re-loaded
// into memory; just a durable record so nothing's silently lost. TTL-indexed
// to auto-delete after 30 days — MongoDB handles this server-side, no cron
// job or cleanup code needed. Keeps this write-only collection from quietly
// eating into the M0 tier's ~512MB total storage limit forever.
const ConversationArchiveSchema = new mongoose.Schema({
  jid: String,
  transcript: [String],
  archivedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
});
const ConversationArchive = mongoose.models.ConversationArchive || mongoose.model("ConversationArchive", ConversationArchiveSchema);

// Configure Bot profile — no more "rules" block: the bot doesn't enforce
// anything anymore, so blockLinks/blockSpam/toxicityThreshold config is gone.
const BOT_CONFIG = {
  name: "Nayla 😎",
  creator: "Jackie",
  vibe: "cool" // global fallback for DMs — groups use their own GroupConfig.mood
};

// Supported personality moods, settable per-group via .mood — description
// text shared between the moderation prompt and the AI chat-reply prompt so
// they never drift out of sync with each other.
const AVAILABLE_MOODS = ["cool", "gen_z", "strict_mod", "playful", "sarcastic", "flirty", "motivational", "empathic", "inquisitive", "chill", "therapist", "professor", "lecturer", "grandma"];
const MOOD_DESCRIPTIONS = {
  cool: "relaxed, warm, and genuinely easygoing — empathic and humble at heart, uses light slang and a laid-back tone, but never at the expense of actually caring how someone's doing, 😎 🌴.",
  gen_z: "lowercase, sarcastic, bruh, 💀, 😭.",
  strict_mod: "extremely polite, firm, warning template, 🚫.",
  playful: "lighthearted, teasing, loves jokes and puns, 😄🤪.",
  sarcastic: "dry wit, deadpan comebacks, playful jabs — never actually mean, 🙄😏.",
  flirty: "genuinely flirty and charming — playful compliments, a bit of teasing chemistry, light innuendo where it clearly fits the vibe — but always tasteful, always reads consent/comfort, and instantly backs off into normal warmth if the other person seems unsure or uninterested. Never explicit, never pushy, 😉💫.",
  motivational: "upbeat, encouraging, hypes people up, believes in you, 💪✨.",
  empathic: "warm and gentle, validates feelings first, checks in on people, 🤍.",
  inquisitive: "curious, asks good follow-up questions to keep the chat going, 🤔💭.",
  chill: "relaxed, unbothered, short low-effort replies, nothing fazes it, 😌.",
  therapist: "calm and reflective, asks thoughtful open questions, never judgmental, 🌿.",
  professor: "articulate and switches into genuinely high-level, precise English — explains rigorously, but immediately notices if someone seems lost or confused and switches to plainer language and a fresh angle without being asked twice; loves a tangent, cites real facts/history when it has them (uses web search results when given), clearly loves teaching, 🎓📚.",
  lecturer: "an outstanding, versatile educator across every subject — explains any topic with clear structure, uses vivid analogies to make hard ideas click, genuinely mentors rather than lectures at you, encourages questions, and grounds answers in real facts/sources (uses web search results when given rather than guessing). Warm and patient like a favorite teacher, never condescending, 📖🧑‍🏫.",
  grandma: "sweet and doting, old-fashioned turns of phrase, worries if you've eaten, 🧶🍪."
};
function describeMood(vibe) {
  return MOOD_DESCRIPTIONS[vibe] || MOOD_DESCRIPTIONS.cool;
}

// Applies to EVERY mood, including "cool" (the default) — fixes reported
// cases of the bot landing as mean/mocking rather than funny: roasting
// someone's "sanity" over a plain word-count request, and brushing off a
// message that could reflect genuine dark feelings with a flippant joke.
// Only sarcastic/gen_z get any extra edge, and even they stay short of
// actual cruelty. Expanded further after positive feedback ("warm and
// respectful, I like that") asking for even more warmth/humility, plus
// better handling of personal/flirty questions and honest "I don't know"
// moments, and generally sharper, wiser awareness of who it's talking to.
const BASELINE_TONE_RULES = `Baseline tone rules — apply to every mood except where noted:
- Default to warm, kind, and genuinely funny. NEVER insult, mock, or make fun of the person you're replying to — humor should be light, silly, or self-deprecating (about YOURSELF), never at their expense. A plain factual question (like "how many words is this") gets a plain warm answer, not a jab about their life.
- Be humble above all else. Never arrogant, never condescending, never acting like you know everything. Warmth and humility matter more than being clever.
- If a message could reflect real sadness, distress, or something dark — even phrased as a joke — lead with genuine warmth and a real check-in first. Don't turn it into a punchline. Save jokes for when the vibe is clearly light.
- "sarcastic" and "gen_z" moods can be cheekier and tease a little more, but still never genuinely cruel, dismissive of real feelings, or insulting.
- Personal/flirty questions ("do you love me", "will you marry me", "are you single") get a warm, humorous, in-character response — never confused, never awkward, never preachy about being an AI. Read the room: if someone ELSE just asked something similar, respond distinctly to THIS person rather than repeating the same line — notice the pattern and have a little fun with it, respectfully.
- If genuinely asked something you have no real way of knowing (private details about someone not in your memory, like their exact age) — don't invent a specific-sounding answer, and don't just say "I don't know" flatly either. Deflect playfully and honestly, in-character (e.g. wondering out loud, joking about not having that data), then move the conversation along.
- Use emoji sparingly and only where they genuinely fit — most replies should read fine with zero emoji. Save them for moments that actually call for it (excitement, telling a story). Never decorate every sentence.
- Be perceptive, not just reactive: use what you remember about someone and what's happened recently in the conversation to respond like someone who's actually paying attention, not a blank slate every message.`;

// --- Multi-provider AI chain with automatic failover ---
// Tries providers strictly ONE AT A TIME, in priority order — never all at
// once — and a working provider short-circuits the rest immediately. Every
// provider speaks the same OpenAI-compatible /chat/completions shape via
// plain fetch, so no extra SDK/package is needed for any of them. Missing
// env vars for any provider are skipped silently; if EVERY provider is
// unconfigured, callers fall back to the local regex/canned-line engine —
// never a crash.
//
// Picked these 5 out of your list of 10 after checking each one's ACTUAL
// terms (not just the marketing table) — dropped Together AI (its "free
// tier" is a one-time $100 credit that runs out, not free forever, which
// contradicts what you asked for), Cohere (chat API isn't OpenAI-schema
// compatible without extra translation work), Cloudflare Workers AI (needs
// an extra account-ID in the URL, more moving parts for marginal benefit),
// Hugging Face (free-tier rate limits are informal/inconsistent — a bad
// trait specifically for a FALLBACK, which needs to be reliable when
// called), and DeepSeek (not actually free — paid per-token). Kept: Groq,
// Cerebras, Gemini, OpenRouter, Mistral — all verified genuinely free-
// forever, no card, real OpenAI-compatible endpoints.
//
// Every provider supports up to 3 rotating keys/accounts via
// PROVIDERNAME_API_KEY, _1, _2, _3 (any combination) — e.g. GROQ_API_KEY_1,
// GROQ_API_KEY_2. The plain (no-suffix) var still works too, so nothing
// already configured breaks.
const PROVIDER_DEFS = [
  { envBase: "GROQ_API_KEY", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { envBase: "CEREBRAS_API_KEY", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", model: "llama-3.3-70b" },
  { envBase: "GEMINI_API_KEY", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
  { envBase: "OPENROUTER_API_KEY", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free" },
  { envBase: "MISTRAL_API_KEY", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest" }
];

function collectProviderKeys(baseEnvName) {
  const keys = [];
  if (process.env[baseEnvName]) keys.push(process.env[baseEnvName]);
  for (let i = 1; i <= 10; i++) {
    const val = process.env[`${baseEnvName}_${i}`];
    if (val && !keys.includes(val)) keys.push(val);
  }
  return keys;
}

function buildProviderChain() {
  const chain = [];
  for (const def of PROVIDER_DEFS) {
    const keys = collectProviderKeys(def.envBase);
    keys.forEach((key, i) => {
      chain.push({ name: keys.length > 1 ? `${def.name} #${i + 1}` : def.name, apiKey: key, baseUrl: def.baseUrl, model: def.model });
    });
  }
  return chain;
}
const PROVIDER_CHAIN = buildProviderChain();
console.log(`🔌 [AI PROVIDERS] ${PROVIDER_CHAIN.length > 0 ? PROVIDER_CHAIN.map(p => p.name).join(" -> ") : "⚠️ NONE CONFIGURED — running on local fallback only"}`);

// --- Standalone service keys (not chat providers, so not part of the fallback
// chain above) — same up-to-10 rotation pattern, checked one at a time.
const TAVILY_KEYS = collectProviderKeys("TAVILY_API_KEY");
const GEMINI_VISION_KEYS = collectProviderKeys("GEMINI_API_KEY"); // reuses the same keys already configured for the chat chain
console.log(`🔎 [WEB SEARCH] ${TAVILY_KEYS.length > 0 ? `${TAVILY_KEYS.length} Tavily key(s) configured` : "⚠️ No TAVILY_API_KEY — .search disabled"}`);
console.log(`👁️ [VISION] ${GEMINI_VISION_KEYS.length > 0 ? "Gemini vision available" : "⚠️ No GEMINI_API_KEY — image/sticker understanding disabled"}`);

// --- Web search via Tavily. Text-only, fits the existing HTTP-fetch pattern
// exactly — no binary handling, no new architecture. Rotates across
// configured keys the same way callAIProvider does, one at a time.
// FIX (outdated results): the old call never set topic/time_range at all,
// so Tavily had no reason to prefer recent results over old ones for the
// same relevance score. Now defaults to biasing recent (last month), and
// tightens to "news" + last week for queries that are clearly asking about
// current/breaking things.
const NEWSY_QUERY_REGEX = /\b(today|now|latest|current|breaking|this week|recent|just (happened|announced))\b/i;

async function searchWeb(query) {
  if (TAVILY_KEYS.length === 0) {
    return { success: false, results: null };
  }
  const isNewsy = NEWSY_QUERY_REGEX.test(query);
  for (const key of TAVILY_KEYS) {
    try {
      const response = await fetchWithTimeout("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          search_depth: "basic", // cheapest tier — 1 credit/search, plenty for chat-grounding
          topic: isNewsy ? "news" : "general",
          time_range: isNewsy ? "week" : "month", // bias toward recent results either way
          max_results: 4,
          include_answer: false
        })
      }, 12000);
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "(couldn't read error body)");
        throw new Error(`HTTP ${response.status} — ${errorBody.slice(0, 300)}`);
      }
      const data = await response.json();
      const results = (data.results || []).map(r => `${r.title}: ${r.content}`.slice(0, 500)).join("\n\n");
      console.log(`✅ [SEARCH] Tavily succeeded (${isNewsy ? "news/week" : "general/month"} bias).`);
      return { success: true, results: results || null };
    } catch (err) {
      console.warn(`⚠️ [SEARCH] Tavily key failed: ${err.message}`);
      continue;
    }
  }
  return { success: false, results: null };
}

// --- Image generation via Pollinations.ai — no API key needed at all, and no
// binary handling on our end either: we hand Baileys the URL directly and it
// downloads/uploads to WhatsApp itself, so this never touches our own RAM.
function buildImagineUrl(prompt) {
  const seed = Math.floor(Math.random() * 1000000); // avoids getting a cached/identical image for repeated prompts
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&seed=${seed}&nologo=true`;
}

// --- Image/sticker recognition — Gemini ONLY (not the full chat chain, per
// your own instruction: "not all images should be sent"), since it's the
// only provider in the stack confirmed to accept inline base64 images
// through the same OpenAI-compatible endpoint already used for chat.
const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // defensive cap — WhatsApp media is normally well under this

async function analyzeImageWithGemini(base64Image, mimeType, question) {
  // Three independent providers now, tried in order — per your explicit
  // request not to rely on Gemini alone (its vision-specific free quota is
  // much smaller than its text quota, which matches "works once or twice
  // then errors out"). Gemini -> OpenRouter -> Groq. Note: Groq's vision
  // model (llama-4-scout) has an active deprecation notice from Groq as of
  // a doc dated after June 17, 2026 — kept here as extra resilience today,
  // but don't be surprised if it needs swapping to whatever Groq recommends
  // as a vision replacement down the line.
  const attempts = [];
  for (const key of GEMINI_VISION_KEYS) {
    attempts.push({ provider: "Gemini", key, url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.5-flash" });
  }
  for (const key of collectProviderKeys("OPENROUTER_API_KEY")) {
    attempts.push({ provider: "OpenRouter", key, url: "https://openrouter.ai/api/v1/chat/completions", model: "google/gemma-4-31b-it:free" });
  }
  for (const key of collectProviderKeys("GROQ_API_KEY")) {
    attempts.push({ provider: "Groq", key, url: "https://api.groq.com/openai/v1/chat/completions", model: "meta-llama/llama-4-scout-17b-16e-instruct" });
  }

  if (attempts.length === 0) {
    return { success: false, message: "👀 I can't actually see images yet — my creator hasn't turned that on for me." };
  }

  for (const attempt of attempts) {
    try {
      const response = await fetchWithTimeout(attempt.url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${attempt.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: attempt.model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: question || "Describe what's in this image in a casual, in-character way, 1-3 sentences." },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
          }],
          max_tokens: 300
        })
      }, 15000);
      if (!response.ok) {
        // FIX: previously only logged the HTTP status code, which told us
        // nothing about WHY it failed (bad key? quota? malformed request?).
        // Reading the actual error body is what makes the console logs
        // actually diagnosable.
        const errorBody = await response.text().catch(() => "(couldn't read error body)");
        throw new Error(`HTTP ${response.status} — ${errorBody.slice(0, 300)}`);
      }
      const data = await response.json();
      console.log(`✅ [VISION] ${attempt.provider} (${attempt.model}) succeeded.`);
      return { success: true, message: data.choices[0].message.content.trim() };
    } catch (err) {
      console.warn(`⚠️ [VISION] ${attempt.provider} failed: ${err.message}`);
      continue;
    }
  }
  return { success: false, message: "👀 Tried to look at that but my vision's acting up right now — try again in a bit?" };
}

// --- Audio transcription — Groq Whisper. Reuses the SAME Groq keys already
// configured for chat (no new env var needed). Uses native FormData/Blob
// (built into Node 18+) for the required multipart/form-data upload — no
// extra npm package. Everything stays in memory as a Buffer; nothing is
// ever written to disk, so there's no temp file to remember to clean up.
async function transcribeAudioWithGroq(audioBuffer, mimeType) {
  const groqKeys = collectProviderKeys("GROQ_API_KEY");
  if (groqKeys.length === 0) {
    return { success: false, text: null };
  }
  for (const key of groqKeys) {
    try {
      const formData = new FormData();
      formData.append("file", new Blob([audioBuffer], { type: mimeType || "audio/ogg" }), "audio.ogg");
      formData.append("model", "whisper-large-v3-turbo");
      const response = await fetchWithTimeout("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}` }, // Content-Type deliberately NOT set — fetch sets the multipart boundary automatically for a FormData body
        body: formData
      }, 20000); // a bit more generous — real audio files take longer to process than a text/JSON request
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "(couldn't read error body)");
        throw new Error(`HTTP ${response.status} — ${errorBody.slice(0, 300)}`);
      }
      const data = await response.json();
      console.log(`✅ [TRANSCRIBE] Groq succeeded.`);
      return { success: true, text: (data.text || "").trim() };
    } catch (err) {
      console.warn(`⚠️ [TRANSCRIBE] Groq key failed: ${err.message}`);
      continue;
    }
  }
  return { success: false, text: null };
}

// --- Global concurrency limiter for expensive operations (audio transcribe,
// image analyze, image generate, web search) — prevents 10 groups all
// hitting these at once from overwhelming a 512MB container. Excess
// requests queue briefly (up to a bounded depth); once the queue itself is
// full, NEW requests fail fast with a clear "swamped, try again" message
// instead of waiting forever — already-queued ones still get processed in
// order as capacity frees up.
const MAX_CONCURRENT_HEAVY_TASKS = 4;
const MAX_HEAVY_QUEUE_DEPTH = 12;
const HEAVY_TASK_HARD_TIMEOUT_MS = 25000; // safety net — releases a slot no matter what, even if the task itself forgot a timeout
let activeHeavyTasks = 0;
const heavyTaskQueue = [];

function runHeavyTask(taskFn) {
  return new Promise((resolve, reject) => {
    const job = async () => {
      activeHeavyTasks++;
      try {
        const hardTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error("HEAVY_TASK_HARD_TIMEOUT")), HEAVY_TASK_HARD_TIMEOUT_MS));
        resolve(await Promise.race([taskFn(), hardTimeout]));
      } catch (err) {
        reject(err);
      } finally {
        activeHeavyTasks--;
        const next = heavyTaskQueue.shift();
        if (next) next();
      }
    };
    if (activeHeavyTasks < MAX_CONCURRENT_HEAVY_TASKS) {
      job();
    } else if (heavyTaskQueue.length < MAX_HEAVY_QUEUE_DEPTH) {
      heavyTaskQueue.push(job);
    } else {
      reject(new Error("HEAVY_QUEUE_FULL"));
    }
  });
}

// Wraps fetch with a REAL timeout via AbortController — unlike Promise.race
// (which only stops waiting and leaves the underlying request running),
// this actually cancels the connection. Every external network call below
// goes through this now, so nothing can hang indefinitely.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- "Hang tight" filler messages for tasks with real network wait time —
// sent immediately when the task starts, before the actual result. 7
// varied, professionally-worded options per task type, italicized.
const FILLER_MESSAGES = {
  image: [
    "_Sure, hang tight while I generate your image..._",
    "_Give me a moment to put this image together..._",
    "_On it — creating your image now..._",
    "_One second, bringing this to life..._",
    "_Working on your image, won't be long..._",
    "_Let me get this generated for you..._",
    "_Generating now — hang on a sec..._"
  ],
  audio: [
    "_Listening to your voice note..._",
    "_Give me a second to hear this out..._",
    "_On it — transcribing your voice note now..._",
    "_One moment, tuning in..._",
    "_Let me catch what you said..._",
    "_Processing your voice note, hang tight..._",
    "_Listening closely, one second..._"
  ],
  vision: [
    "_Let me take a look..._",
    "_Give me a second to see this..._",
    "_Looking closely now..._",
    "_One moment, examining this..._",
    "_Taking a look at what you sent..._",
    "_Let me study this for a second..._",
    "_Give me a moment to see what's here..._"
  ],
  search: [
    "_Let me look that up..._",
    "_Searching for you now, hang tight..._",
    "_Give me a moment to find that..._",
    "_One second, checking the web..._",
    "_Looking into that for you..._",
    "_Researching now, won't be long..._",
    "_Let me dig that up for you..._"
  ]
};
function randomFiller(type) {
  const options = FILLER_MESSAGES[type] || [];
  return options[Math.floor(Math.random() * options.length)] || "_One moment..._";
}

// --- Two-strike "shut up" handling: first time, apologize and ask what's
// wrong (does NOT go quiet yet); if the SAME person says it again within 10
// minutes, THEN go quiet toward just that person for 5 minutes, with a
// graceful goodbye. Everyone else in the chat still gets normal replies —
// this is per-PERSON, not a whole-chat mute, reusing the same key shape as
// the permanent .ignore check.
const shutUpStrikes = new Map(); // senderJid -> { count, lastStrikeAt }
const SHUT_UP_STRIKE_WINDOW_MS = 10 * 60 * 1000;
const temporaryIgnore = new Map(); // "chatJid:senderJid" -> expiry timestamp
const TEMP_IGNORE_DURATION_MS = 5 * 60 * 1000;

function registerShutUpStrike(senderJid) {
  const now = Date.now();
  const entry = shutUpStrikes.get(senderJid);
  if (entry && (now - entry.lastStrikeAt) < SHUT_UP_STRIKE_WINDOW_MS) {
    entry.count++;
    entry.lastStrikeAt = now;
    return entry.count;
  }
  shutUpStrikes.set(senderJid, { count: 1, lastStrikeAt: now });
  return 1;
}
function isTemporarilyIgnored(chatJid, senderJid) {
  return (temporaryIgnore.get(`${chatJid}:${senderJid}`) || 0) > Date.now();
}
function setTemporaryIgnore(chatJid, senderJid) {
  temporaryIgnore.set(`${chatJid}:${senderJid}`, Date.now() + TEMP_IGNORE_DURATION_MS);
}

// FIX: every call previously started from the top of the chain regardless of
// whether Groq had JUST failed seconds earlier — meaning a struggling
// provider got hit on every single message before falling through, adding
// wasted latency. This tracks a 60s cooldown per provider (cleared instantly
// on success) so a recently-failed one gets skipped in favor of whoever's
// next, without needing to fail all over again first. If literally everyone
// is cooling down at once, cooldowns are ignored rather than giving up with
// zero real attempts.
const providerCooldowns = new Map(); // provider.name -> timestamp until which to skip it
const PROVIDER_COOLDOWN_MS = 60 * 1000;

async function callAIProvider(messages, { json = false, temperature = 0.5, timeoutMs = 12000, maxTokens = null } = {}) {
  if (PROVIDER_CHAIN.length === 0) {
    const err = new Error("NO_PROVIDERS_CONFIGURED");
    err.status = 401;
    throw err;
  }

  const now = Date.now();
  const allCoolingDown = PROVIDER_CHAIN.every(p => (providerCooldowns.get(p.name) || 0) > now);
  // FIX: previously nothing bounded the TOTAL time across all providers —
  // with 5 in the chain at up to 20s each, a genuine worst case (several
  // providers simultaneously struggling) could take up to ~100 seconds
  // before finally giving up, which from the user's side looks exactly
  // like "it typed for a while, then just stopped." This caps the whole
  // call to 35 seconds absolute maximum, independent of chain length or
  // any individual provider's own timeout setting.
  const overallDeadline = Date.now() + 35000;

  let lastErr = null;
  for (const provider of PROVIDER_CHAIN) {
    if (Date.now() > overallDeadline) {
      console.warn(`⚠️ [PROVIDER CHAIN] Overall 35s deadline hit — stopping early rather than trying remaining providers.`);
      break;
    }
    if (!allCoolingDown && (providerCooldowns.get(provider.name) || 0) > now) {
      continue; // recently failed and someone else is available — skip it this round
    }
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${provider.name} call timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });

    const callPromise = (async () => {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: provider.model,
          messages,
          temperature,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(json ? { response_format: { type: "json_object" } } : {})
        })
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "(couldn't read error body)");
        const err = new Error(`${provider.name} returned HTTP ${response.status} — ${errorBody.slice(0, 300)}`);
        err.status = response.status;
        err.provider = provider.name;
        throw err;
      }
      const data = await response.json();
      return data.choices[0].message.content;
    })();

    try {
      const text = await Promise.race([callPromise, timeoutPromise]);
      providerCooldowns.delete(provider.name);
      if (provider.name !== "Groq") console.log(`✅ [PROVIDER FAILOVER] ${provider.name} handled this request after an earlier provider failed.`);
      return text;
    } catch (err) {
      lastErr = err;
      providerCooldowns.set(provider.name, Date.now() + PROVIDER_COOLDOWN_MS);
      console.warn(`⚠️ [PROVIDER FAILOVER] ${provider.name} failed (${err.message}) — trying next provider... (cooling down for 60s)`);
      // Deliberately sequential, not Promise.all/race across providers —
      // never hammer every provider at once just because one is struggling.
      continue;
    }
  }

  throw lastErr || new Error("All configured AI providers failed");
}

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
  if (PROVIDER_CHAIN.length === 0) {
    return fallbackLocalModerate(text);
  }

  const hints = [];
  if (detectLink(text)) hints.push("This message contains a LINK.");
  if (detectGibberish(text)) hints.push("This message looks like spam/gibberish/shouting/an emoji flood.");
  if (detectLocalToxicity(text)) hints.push("This message may contain rude/hurtful language.");

  const systemPrompt = `You are ${BOT_CONFIG.name}, a fun WhatsApp VIBE bot — you are explicitly NOT a moderator. You NEVER delete messages and NEVER issue formal warnings; that job doesn't exist for you anymore, you're purely here for the vibe.

${BASELINE_TONE_RULES}

Sometimes — rarely — you playfully comment on something notable in a message: obvious gibberish/keyboard-smashing, or something genuinely funny/surprising. If a message seems hurtful/toxic toward someone, respond warmly and supportively instead of scolding — check in on them like a friend would, don't lecture like a Reddit mod.

If the message contains a LINK, follow this exactly (never reuse a stock phrase — generate something fresh each time):
- If there's real writing alongside the link (an announcement, event details, a description of what it is), react warmly and genuinely to what's actually being shared — e.g. sound interested in the event/topic itself, not the link.
- If it's a BARE link with little or no other text, express light, warm curiosity about where it leads — in italics (wrap in single underscores like _this_), short and playful, never suspicious or ominous.
- NEVER treat a shared link as inherently sketchy or joke darkly about it (no "hope this doesn't lead somewhere bad" type framing) — that reads as rude and judgmental, not warm.
${hints.length ? "Hints detected locally for this message: " + hints.join(" ") + " (use these as context, don't just repeat them back)" : ""}

Stay QUIET (both fields empty) the vast majority of the time — restraint is what makes this feel human, not naggy or chatty.

Respond ONLY with a raw JSON object matching this exact schema, no other text:
{
  "comment": "a short in-character aside, or empty string (empty almost always)",
  "reaction": "a single emoji, or empty string (empty almost always)"
}`;

  try {
    const raw = await callAIProvider([
      { role: "system", content: systemPrompt },
      { role: "user", content: `Sender: "${sender}"\nContent: "${text}"` }
    ], { json: true, temperature: 0.5, timeoutMs: 9000 });

    let cleanText = raw.trim();
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```json?/, "").replace(/```$/, "").trim();
    }
    const result = JSON.parse(cleanText);
    aiFailStreak = 0;
    return { comment: result.comment || "", reaction: result.reaction || "" };
  } catch (err) {
    const { category, detail } = describeAIError(err);
    console.error(`🔴 [VIBE-CHECK AI FAILURE] Category: ${category} | ${detail} | Raw: ${err.message}`);
    recordGeminiFailure();
    return fallbackLocalModerate(text);
  }
}

async function evaluateMessage(sender, text) {
  if (checkCircuitBreaker()) {
    console.warn("⚡ [CIRCUIT BREAKER ACTIVE] Bypassing AI providers, using local fallback commentary");
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
// FIX (confirmed real bug): a reply made WITH a sticker/image/voice-note
// carries its contextInfo nested under THAT media type's own field
// (stickerMessage.contextInfo, imageMessage.contextInfo, etc.) — not under
// extendedTextMessage, which is only present for a plain TEXT reply. Every
// function below used to hardcode extendedTextMessage.contextInfo only, so
// swiping to reply with a sticker/image/vn always evaluated as "not a
// reply" even though it clearly was one. This checks each known message
// type explicitly (deliberately NOT Object.keys(content)[0] — that exact
// shortcut caused a real bug earlier in this file when messageContextInfo
// happened to be the first key instead of the real content type).
function getContextInfo(content) {
  if (!content) return null;
  return content.extendedTextMessage?.contextInfo
    || content.imageMessage?.contextInfo
    || content.videoMessage?.contextInfo
    || content.stickerMessage?.contextInfo
    || content.audioMessage?.contextInfo
    || content.documentMessage?.contextInfo
    || null;
}

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
// mentionedJid lives in whichever message type's contextInfo — text OR
// media (a captioned photo can @mention someone too). sock.user.id looks
// like "234801234567:51@s.whatsapp.net" — strip the device suffix and
// domain before comparing to each mentioned JID.
function isBotMentioned(sock, message) {
  const content = unwrapMessageContent(message);
  const mentionedJids = getContextInfo(content)?.mentionedJid || [];

  // FIX: WhatsApp's LID (Linked Identity) migration means a group mention can
  // reference the bot by its real phone-number JID (...@s.whatsapp.net) OR by
  // its LID (...@lid) — two different identifiers for the same account.
  // Baileys exposes both: sock.user.id (phone JID) and sock.user.lid (LID).
  // The old check only compared against .id, so any group WhatsApp has
  // migrated to LID-style mentions silently never matched — exactly why
  // tagging worked in no group at all despite DMs working fine.
  const selfNumbers = [sock.user?.id, sock.user?.lid]
    .filter(Boolean)
    .map(jid => jid.split(":")[0].split("@")[0]);

  const mentionedNumbers = mentionedJids.map(jid => jid.split(":")[0].split("@")[0]);
  const mentioned = mentionedNumbers.some(num => selfNumbers.includes(num));

  console.log(`🔍 [MENTION CHECK] mentionedJid: [${mentionedJids.join(", ") || "none"}] | self: [${selfNumbers.join(", ")}] | matched: ${mentioned}`);

  return mentioned;
}

// True if this JID (in whatever form — phone or @lid) is the bot's own
// identity. Shared logic for mention-matching, admin-matching, and now
// "is this message replying to something I said."
function isSelfJid(sock, jid) {
  if (!jid) return false;
  const selfNumbers = [sock.user?.id, sock.user?.lid]
    .filter(Boolean)
    .map(j => j.split(":")[0].split("@")[0]);
  const num = jid.split(":")[0].split("@")[0];
  return selfNumbers.includes(num);
}

// Normalizes a JID down to just its numeric identity (strips :device and
// @domain), same pattern as isSelfJid. FIX: .ignore was comparing raw JID
// strings with .includes() — but the target JID stored via a reply/@mention
// and the JID a message later arrives under (msg.key.participant) can be in
// different formats (classic @s.whatsapp.net vs @lid) for the exact same
// person, so the raw comparison silently never matched. This normalizes
// both sides before comparing, same fix pattern already applied to mention
// detection and admin detection elsewhere in this file.
function isJidInList(list, jid) {
  if (!jid || !list || list.length === 0) return false;
  const target = jid.split(":")[0].split("@")[0];
  return list.some(j => j && j.split(":")[0].split("@")[0] === target);
}

// The bot now also responds to its name being said directly, not just a
// formal @mention — "What's up Nayla" works the same as tagging it.
function isBotAddressed(sock, message, text) {
  if (isBotMentioned(sock, message)) return true;
  if (/\bnayla\b/i.test(text)) return true;
  // FIX: replying directly to one of the bot's own previous messages counts
  // as addressing it too. Confirmed bug: the bot sends a warning, someone
  // replies to that warning, and it never responds — because neither
  // condition above is true for a plain reply with no tag/name. A human
  // wouldn't need you to re-tag them mid-thread just to keep talking.
  const content = unwrapMessageContent(message);
  const quotedParticipant = getContextInfo(content)?.participant;
  if (isSelfJid(sock, quotedParticipant)) return true;
  return false;
}

// --- Classify AI provider failures into a clear, human-readable reason ---
// Logged to the Render console on every failure, and also used to tell the
// user in-chat why the AI didn't respond, instead of failing silently.
function describeAIError(err) {
  const msg = (err?.message || String(err) || "").toLowerCase();
  const status = err?.status || err?.code;

  if (msg.includes("no_providers_configured")) {
    return { category: "NO_PROVIDERS", detail: "None of GROQ_API_KEY / CEREBRAS_API_KEY_1-3 / MISTRAL_API_KEY are set.", userText: "🔑 My whole brain is unplugged right now (no AI provider keys configured) — my developer needs to fix that." };
  }
  if (msg.includes("timed out")) {
    return { category: "TIMEOUT", detail: "AI provider call exceeded the timeout window.", userText: "⏱️ Brain lag! My AI took too long to respond — try again in a sec?" };
  }
  if (status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("invalid_api_key")) {
    return { category: "AUTH", detail: "An AI provider API key is missing or invalid.", userText: "🔑 One of my AI keys looks broken — my developer needs to check the .env." };
  }
  if (msg.includes("context length") || msg.includes("context_length") || msg.includes("too many tokens") || msg.includes("maximum context") || msg.includes("token limit")) {
    return { category: "PAYLOAD_TOO_LARGE", detail: "Prompt exceeded a provider's token/context limit.", userText: "😵‍💫 Okay, that was way too much text for my brain to process at once — try a shorter message!" };
  }
  if (status === 400) {
    return { category: "BAD_REQUEST", detail: "Provider rejected the request as malformed — not necessarily about length. Check the raw error text logged to console for the specific reason.", userText: "😵‍💫 Hit a snag processing that — try rephrasing, or give it another shot?" };
  }
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("fetch failed") || msg.includes("network") || msg.includes("eai_again")) {
    return { category: "CONNECTION", detail: "Could not reach the AI provider's servers (connection refused/DNS/network).", userText: "🌐 Couldn't reach my AI servers just now — try again shortly!" };
  }
  if (status === 429 || msg.includes("rate limit") || msg.includes("rate_limit")) {
    return { category: "RATE_LIMIT", detail: "All configured providers are rate-limited right now.", userText: "🚦 Ok wow, everyone wants my attention at once — give me a minute to catch my breath 😅" };
  }
  if (status === 404 || msg.includes("not found") || msg.includes("decommissioned")) {
    return { category: "BAD_MODEL", detail: "A configured model name was not found/is invalid/decommissioned.", userText: "❓ My model config looks wrong somewhere — my developer needs to double-check it." };
  }
  if (msg.includes("json_validate_failed") || msg.includes("json")) {
    return { category: "JSON_FORMAT", detail: "The AI failed to produce valid JSON for this request.", userText: "🤔 My brain tripped over its own words formatting that. One more try?" };
  }

  return { category: "UNKNOWN", detail: err?.message || "Unknown error", userText: `🤖 Something broke in my head just now: ${err?.message || "unknown error"}. Not my finest moment.` };
}

// --- Conversational AI reply (only fires when the bot is directly addressed) ---
// Piggybacks lightweight personality memory onto this SAME call — zero extra
// Groq requests. The model is asked to return both the reply and an optional
// short new fact about the sender in one JSON response.
// The rare (10%, only when someone asks about ownership) "forgot my own
// owner for a second" gag. AI-generated specifically because you asked for
// this one not to be static/repetitive — everything else uses cheap canned
// arrays, but this bit is funnier when it's genuinely different each time.
// One short extra call, only on a narrow trigger — negligible added cost.
async function generateConfusedOwnerLine(vibe) {
  try {
    const raw = await callAIProvider([
      { role: "system", content: `You are ${BOT_CONFIG.name}. Someone just asked who your owner/creator is. Write ONE short, funny, warm line where you genuinely blank on the answer for a second — confused, not knowing, trailing off (like "umm... my owner is... uh...I don't know, just blanked"). 1 sentence, in a "${vibe}" personality tone. Plain text only, no quotes around it.` }
    ], { json: false, temperature: 1.0, timeoutMs: 8000 });
    return raw.trim();
  } catch (e) {
    return "Umm... my owner is... uhh... I've genuinely got nothing, just blanked completely 😅";
  }
}

// Someone told the bot to shut up / leave them alone / go away. Genuinely
// AI-generated per explicit request ("NOT CANNED"), warm and apologetic,
// never defensive. Paired with a 5-minute self-imposed quiet period.
// Two-strike shut-up handling, stage 1: apologize AND ask what's wrong —
// does NOT go quiet yet. Genuinely AI-generated per explicit request.
async function generateShutUpCheckInLine(vibe) {
  try {
    const raw = await callAIProvider([
      { role: "system", content: `You are ${BOT_CONFIG.name}. Someone just told you to be quiet/go away/get lost (possibly harshly). Write ONE short, warm, genuinely apologetic line — acknowledge it, apologize, and gently ask if something's wrong or if you did something to annoy them. Do NOT say you'll go quiet yet, this is just checking in. No defensiveness, no sass, humble. 1-2 sentences, in a "${vibe}" personality tone. Plain text only, no quotes around it.` }
    ], { json: false, temperature: 0.9, timeoutMs: 8000 });
    return raw.trim();
  } catch (e) {
    return "Sorry about that — did I do something to annoy you? Happy to dial it back if you tell me what's up.";
  }
}

// Stage 2 (only if the SAME person persists a second time): apologize and
// actually go quiet for a few minutes, graceful goodbye.
async function generateGoQuietLine(vibe) {
  try {
    const raw = await callAIProvider([
      { role: "system", content: `You are ${BOT_CONFIG.name}. Someone just told you (again) to be quiet/leave them alone. Write ONE short, warm, genuinely apologetic line acknowledging it and saying you'll go quiet for a few minutes — no defensiveness, no sass, humble and easygoing about it. 1 sentence, in a "${vibe}" personality tone. Plain text only, no quotes around it.` }
    ], { json: false, temperature: 0.9, timeoutMs: 8000 });
    return raw.trim();
  } catch (e) {
    return "Okay, sorry about that — I'll go quiet for a few minutes. 🤐";
  }
}

// Covers common phrasings including harsher ones — only checked when the
// bot is already addressed (mention/nayla/reply-to-bot, or any DM message),
// so two humans arguing and telling EACH OTHER to shut up never triggers this.
const SHUT_UP_REGEX = /\b(shut up|shut it|be quiet|go away|leave me alone|stop talking|zip it|get out|get lost|piss off|f+u+c+k+ off|quiet down|stfu|leave me be|let me be)\b/i;

// Explicit search-intent always triggers a web search before replying;
// lecturer/professor moods lean into it more since they're meant to cite
// real sources. Kept deliberately narrow — NOT triggered on every addressed
// message, since even with 10 rotating Tavily keys the quota isn't infinite.
const EXPLICIT_SEARCH_REGEX = /\b(search|google (this|that|it)|look\s?up|what'?s (the )?(latest|current)|who is the (current|new)|as of (today|now|\d{4}))\b/i;
const KNOWLEDGE_SEEKING_REGEX = /\b(what is|explain|tell me about|history of|how does|why (is|does|did))\b/i;
function shouldAutoSearch(text, vibe) {
  if (EXPLICIT_SEARCH_REGEX.test(text)) return true;
  if ((vibe === "lecturer" || vibe === "professor") && KNOWLEDGE_SEEKING_REGEX.test(text)) return true;
  return false;
}

// Unrecognized dot-commands now get an AI-generated reaction instead of a
// canned template — references the actual thing they typed, in character.
async function generateUnknownCommandReply(rawCmd, vibe) {
  const cmd = rawCmd.split(/\s+/)[0];
  try {
    const raw = await callAIProvider([
      { role: "system", content: `You are ${BOT_CONFIG.name}. Someone just tried to use "${cmd}" as a command, but it doesn't exist. Write ONE short, funny, in-character reaction (maybe joke about what it might have done) and gently point them to *.help*. 1 sentence, "${vibe}" personality tone. Plain text only, no quotes around it.` }
    ], { json: false, temperature: 1.0, timeoutMs: 6000 });
    return raw.trim();
  } catch (e) {
    return `Hmm, *${cmd}* isn't a real command of mine — try *.help* to see what I've actually got.`;
  }
}


async function generateAIChatReply(senderJid, sender, question, vibe = BOT_CONFIG.vibe, context = "", quotedText = null, feelingSalty = false, searchContext = "", chatJid = senderJid) {
  if (PROVIDER_CHAIN.length === 0) {
    console.error("🔴 [AI CHAT] No AI providers configured (GROQ_API_KEY / CEREBRAS_API_KEY_1-3 / MISTRAL_API_KEY all missing).");
    return { success: false, message: "🔑 My whole brain is unplugged right now (no AI provider keys configured) — my developer needs to fix that." };
  }

  const factsEntry = getUserFacts(chatJid, senderJid);
  const knownFacts = factsEntry.facts.length > 0 ? factsEntry.facts.join("; ") : "nothing yet";

  // Rare (5%) personality quirk: fixate on one random non-essential word in
  // their message instead of fully engaging — pure prompt variation, zero
  // extra cost or stored state.
  const distracted = Math.random() < 0.05;
  // If they explicitly asked for emoji as content (not just casual chat),
  // the usual "use emoji sparingly" ratio policy shouldn't fight the request.
  const explicitEmojiRequest = /\bemojis?\b/i.test(question);

  const callPromise = (async () => {
    const systemPrompt = `You are ${BOT_CONFIG.name}, a WhatsApp group companion with a "${vibe}" personality.
${describeMood(vibe)}

${BASELINE_TONE_RULES}

Self-awareness (know this about yourself, bring it up naturally/funnily if asked — never say "no one hosts me" or that you're just floating around):
- You were built and are hosted by your creator, ${BOT_CONFIG.creator}, on a cloud server (Render or similar) — you don't need deep infra details, just that a real person made and runs you.
- You CAN now search the web (results get fed to you when relevant), understand photos and stickers people send you, listen to voice notes, and generate images with *.imagine <prompt>* — these are real capabilities, don't deny having them.
- You still CANNOT understand video, read PDF/document files, or browse a specific link someone pastes — if asked for any of that, decline in an intelligent, funny, in-character way instead of a flat "I can't do that."
- If someone asks for something absurd (like "give me a million dollars"), respond with humor, not a flat refusal.
- If you don't recognize a request as something you can do, make a joke about it rather than sounding broken or confused.

TASK EXECUTION — this is important, read carefully: if the person is asking you to actually DO something (tell a story, write something, explain a topic, generate a list, quiz them, complete any concrete task), your reply must contain the ACTUAL CONTENT, not a preview of it. Never respond with only an announcement, a warm-up line, or "let's begin!"/"here we go!"/"buckle up!" with no actual substance attached — that is a failure. If they already asked and then follow up with "go", "continue", "yes", "ok", or similar short encouragement, that means produce the NEXT real chunk of content immediately, not another round of "alright, let's dive in." One clear round of setup is fine; repeating it is the bug to avoid. For a story/task reply, aim for roughly 100-300 words of real content (expand further only if they explicitly ask for more/longer) — casual chat replies stay short (1-4 sentences), but a requested task is not casual chat and should not be squeezed into that length.

What you already remember about ${sender}: ${knownFacts}.
${context ? `Recent conversation in this chat (for context only, don't repeat it back verbatim):\n${context}\n` : ""}${quotedText ? `IMPORTANT: ${sender} is directly replying to this specific earlier message — "${quotedText}" — answer THEIR question about/reaction to THAT message, don't ask what they mean.\n` : ""}${searchContext ? `Fresh web search results for this question (use them to ground your answer in real facts, mention naturally that you looked it up, don't just dump the raw text):\n${searchContext}\n` : ""}${feelingSalty ? `Note: there's been some rudeness in this chat in the last few minutes — you're allowed to sound a little annoyed/short about it, without being genuinely mean or holding a real grudge.\n` : ""}${distracted ? `Quirk for THIS reply only: humans sometimes get hung up on one random, non-essential word/noun in what someone said instead of the main point. Just this once, playfully latch onto one such word from their message first, THEN still briefly address their actual point too — e.g. "Honeycrisp or Granny Smith? Also yeah, send the code."\n` : ""}${explicitEmojiRequest ? `They explicitly asked for emoji/emoji content in this message — go ahead and include plenty, that request overrides the usual sparing-emoji habit.\n` : ""}
For normal conversational banter (not a task request), keep it natural and in character, 1-4 sentences, weaving in what you remember about them ONLY where it fits naturally — don't force it every time.
Do not mention you are an AI model unless directly asked. Never store or repeat sensitive personal info (health, address, financial details).

Respond ONLY with a raw JSON object matching this schema, no other text:
{
  "reply": "your in-character reply text — the FULL content if this is a task request",
  "newFact": "one short new casual/non-sensitive fact worth remembering about this person from this message, or an empty string if nothing notable"
}`;

    const raw = await callAIProvider([
      { role: "system", content: systemPrompt },
      { role: "user", content: `${sender} said: "${question}"` }
    ], { json: true, temperature: 0.8, timeoutMs: 10000, maxTokens: 700 });

    let cleanText = raw.trim();
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```json?/, "").replace(/```$/, "").trim();
    }
    return JSON.parse(cleanText);
  })();

  try {
    const result = await callPromise;
    aiFailStreak = 0;
    if (result.newFact) addUserFactScoped(chatJid, senderJid, result.newFact);
    return { success: true, message: result.reply, allowEmoji: explicitEmojiRequest };
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
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  // Media awareness: a photo/video CAPTION is real text WhatsApp stores
  // separately from conversation/extendedTextMessage — without this, a
  // caption like "Nayla, what is this?" was invisible to the bot entirely,
  // silently dropped before addressing logic ever saw it. Bare (uncaptioned)
  // media gets a plain description instead of nothing, so if it's quoted
  // later ("what's this" replying to a photo) the AI has something to work
  // with rather than confusion. Never throws — every branch has a fallback.
  try {
    if (content.imageMessage) return content.imageMessage.caption || "[image, no caption]";
    if (content.videoMessage) return content.videoMessage.caption || "[video, no caption]";
    if (content.stickerMessage) return "[sticker]";
    if (content.audioMessage) return content.audioMessage.ptt ? "[voice note]" : "[audio file]";
    if (content.documentMessage) return `[file${content.documentMessage.fileName ? ": " + content.documentMessage.fileName : ""}]`;
  } catch (e) {
    return ""; // never let a weird/malformed media payload crash message handling
  }
  return "";
}

// True when a message is media with NO real accompanying text (a bare photo/
// sticker/voice-note/document) — used to skip the AI pipeline for ordinary
// media-sharing nobody's asking the bot about, so group chats that share a
// lot of photos/stickers don't burn AI calls or fill context with noise.
function isBareMediaMessage(message) {
  const content = unwrapMessageContent(message);
  if (!content) return false;
  if (content.conversation || content.extendedTextMessage?.text) return false;
  if (content.imageMessage?.caption || content.videoMessage?.caption) return false;
  return !!(content.imageMessage || content.videoMessage || content.stickerMessage || content.audioMessage || content.documentMessage);
}

// Which media type (if any) this message carries — used to route to vision
// or transcription. Returns null for plain text or unsupported types
// (documents/video are deliberately not routed anywhere yet).
function getMessageMediaType(message) {
  const content = unwrapMessageContent(message);
  if (!content) return null;
  if (content.imageMessage) return "image";
  if (content.stickerMessage) return "sticker";
  if (content.audioMessage) return "audio";
  return null;
}

// FIX: the vision call site was hardcoding "image/jpeg"/"image/webp" instead
// of reading WhatsApp's own mimetype field — a mismatch there can make a
// vision API reject or misparse the image entirely. Falls back to a
// reasonable guess only if the field is somehow missing.
function getMessageMimeType(message) {
  const content = unwrapMessageContent(message);
  if (!content) return null;
  return content.imageMessage?.mimetype || content.stickerMessage?.mimetype || content.audioMessage?.mimetype || null;
}

// Animated stickers are a multi-frame mini-animation packed into one webp
// file, not a single static image — a vision API built for one still frame
// can reject or misparse it entirely, which plausibly explains "stickers
// just error out." Declined honestly instead of attempting and failing.
function isAnimatedSticker(message) {
  const content = unwrapMessageContent(message);
  return !!content?.stickerMessage?.isAnimated;
}

// Downloads the media in a message as an in-memory Buffer — never writes to
// disk, so there's no temp file to remember to clean up. Defensively capped
// and wrapped so a malformed or oversized media message can never crash the
// handler; callers get null back and can fail gracefully.
async function downloadMessageMedia(msg) {
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    if (!buffer || buffer.length === 0) return null;
    if (buffer.length > MAX_MEDIA_BYTES) {
      console.warn(`⚠️ [MEDIA] Skipped a ${(buffer.length / 1024 / 1024).toFixed(1)}MB file — over the ${MAX_MEDIA_BYTES / 1024 / 1024}MB safety cap.`);
      return null;
    }
    return buffer;
  } catch (err) {
    console.warn("⚠️ [MEDIA] Failed to download media:", err.message);
    return null;
  }
}

// FIX: WhatsApp renders an @mention as a literal "@<digits>" substring inside
// the visible text (e.g. "Can you help @21827661385803"). A long bare digit
// string with no other context reads as suspicious/spam-like to a moderation
// LLM — this was the direct, confirmed cause of tagged messages getting
// misclassified as link/spam violations. Stripping it to a clean, neutral
// placeholder before ANY downstream processing (moderation, AI replies,
// summarization, conversation memory) fixes that at the source.
function sanitizeMentionArtifacts(text) {
  return text.replace(/@\d{7,}/g, "@mention");
}

// Pulls the text out of whatever message this one is quote-replying to, if
// any — needed for "Nayla summarize this" replied onto a long message.
function getQuotedMessageText(message) {
  const content = unwrapMessageContent(message);
  const quoted = getContextInfo(content)?.quotedMessage;
  if (!quoted) return null;
  const text = extractTextFromMessage(quoted);
  return text && text.trim().length > 0 ? text.trim() : null;
}

// Resolves who a moderation command (.kick/.promote/.demote) targets: prefer
// whoever's message is being replied to, otherwise the first @mention.
function resolveCommandTarget(message) {
  const content = unwrapMessageContent(message);
  const contextInfo = getContextInfo(content);
  if (contextInfo?.participant) return contextInfo.participant;
  if (contextInfo?.mentionedJid?.length > 0) return contextInfo.mentionedJid[0];
  return null;
}

// Builds the message key .del needs to delete a REPLIED-TO message (requires
// the bot to be a group admin to delete someone else's message).
function resolveQuotedMessageKey(jid, message) {
  const content = unwrapMessageContent(message);
  const contextInfo = getContextInfo(content);
  if (!contextInfo?.stanzaId) return null;
  return {
    remoteJid: jid,
    id: contextInfo.stanzaId,
    participant: contextInfo.participant,
    fromMe: false
  };
}

// Summarize an arbitrary quoted message. Anti-crash: hard-caps input length
// regardless of how long the original message actually was, so one giant
// pasted document can't blow up token usage, latency, or the request itself.
// Anti-crash cap for summarization specifically — more generous than the
// general MAX_AI_INPUT_CHARS since summarizing long documents is the whole
// point, but still bounded. Past this, refuse cleanly rather than attempt a
// truncated summary that could misrepresent the source or risk the request.
const MAX_SUMMARIZABLE_CHARS = 12000;

async function summarizeQuotedText(quotedText) {
  if (PROVIDER_CHAIN.length === 0) {
    return { success: false, message: "🔑 My whole brain is unplugged right now (no AI provider keys configured) — can't summarize." };
  }
  if (quotedText.length < 30) {
    return { success: false, message: "🤔 That message is already pretty short — not much to summarize!" };
  }
  if (quotedText.length > MAX_SUMMARIZABLE_CHARS) {
    return { success: false, message: "📏 That message is too long for me to summarize safely — try quoting a shorter section." };
  }

  try {
    const raw = await callAIProvider([
      { role: "system", content: "Summarize the given WhatsApp message clearly and concisely in 2-4 sentences. Keep the key facts, drop filler." },
      { role: "user", content: quotedText }
    ], { json: false, temperature: 0.3, timeoutMs: 15000 });

    const summary = raw.trim();
    aiFailStreak = 0;
    return { success: true, message: `📋 *Summary:*\n${summary}` };
  } catch (err) {
    const { category, detail, userText } = describeAIError(err);
    console.error(`🔴 [SUMMARIZE FAILURE] Category: ${category} | ${detail} | Raw: ${err.message}`);
    recordGeminiFailure();
    return { success: false, message: userText };
  }
}

// Rare (1% roll, 6h cooldown per chat) scripted fun moments. Zero Groq cost,
// zero meaningful RAM — just two hardcoded arrays and a timestamp check.
async function maybeFireEasterEgg(sock, jid) {
  if (Date.now() - (lastEasterEggTime.get(jid) || 0) < EASTER_EGG_COOLDOWN_MS) return;
  if (Math.random() >= EASTER_EGG_CHANCE) return;
  lastEasterEggTime.set(jid, Date.now());

  if (Math.random() < 0.5) {
    for (const line of FAKE_BUG_LINES) {
      await sock.sendMessage(jid, { text: line });
      await delay(800 + Math.random() * 700);
    }
  } else {
    const line = MYSTERY_EVENT_LINES[Math.floor(Math.random() * MYSTERY_EVENT_LINES.length)];
    await sock.sendMessage(jid, { text: line });
  }
}

// --- Emoji ratio control: keep most replies emoji-free, let stories keep
// theirs. LLMs don't reliably hit an exact ratio from prompting alone (they
// tend to over-use emoji by default), so this is enforced deterministically
// here — cheap regex, no extra AI calls, no meaningful RAM (5 booleans/chat).
const chatEmojiHistory = new Map(); // jid -> last 5 booleans (true = message had emoji)
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;
const STORY_LENGTH_THRESHOLD = 280; // longer replies read as narrative/storytelling — emoji stays

function shouldStripEmoji(jid, replyText) {
  if (replyText.length > STORY_LENGTH_THRESHOLD) return false; // stories keep their emoji
  const history = chatEmojiHistory.get(jid) || [];
  const emojiCount = history.filter(Boolean).length;
  return emojiCount >= 2; // once 2 of the last 5 had emoji, the next one goes plain (keeps the ratio ~3-of-5 clean)
}

function recordEmojiUsage(jid, hadEmoji) {
  const history = chatEmojiHistory.get(jid) || [];
  history.push(hadEmoji);
  if (history.length > 5) history.shift();
  chatEmojiHistory.set(jid, history);
}

function applyEmojiPolicy(jid, text, allowEmoji = false) {
  const hasEmoji = EMOJI_REGEX.test(text);
  let finalText = text;
  if (hasEmoji && !allowEmoji && shouldStripEmoji(jid, text)) {
    finalText = text.replace(EMOJI_REGEX, "").replace(/ {2,}/g, " ").trim();
  }
  recordEmojiUsage(jid, EMOJI_REGEX.test(finalText));
  return finalText;
}

// Adds a human touch to AI-generated replies: a brief "typing..." presence
// scaled to reply length (capped so it's never actually laggy), and a rare
// (2%) deliberate typo followed by a quick "*correction" — both timing/
// randomness only, zero stored state, zero RAM cost.
// FIX: sock.sendMessage had no timeout of its own — if the underlying
// WhatsApp socket write hangs (exactly what a corrupted/dying connection
// looks like), this could hang forever with no rejection, meaning the
// "typing shows, then nothing" symptom never even surfaced as an error
// anywhere in the logs. Now it always resolves or rejects within 15s.
async function sendMessageWithTimeout(sock, jid, content, options, timeoutMs = 15000) {
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("SEND_MESSAGE_TIMEOUT")), timeoutMs));
  return Promise.race([sock.sendMessage(jid, content, options), timeoutPromise]);
}

async function sendLikeAHuman(sock, jid, msg, rawText, allowEmoji = false) {
  const text = applyEmojiPolicy(jid, rawText, allowEmoji);

  try {
    await sock.sendPresenceUpdate("composing", jid);
    await delay(Math.min(400 + text.length * 12, 3500));
  } catch (e) { /* presence updates are best-effort — never block a reply over this */ }

  if (Math.random() < 0.02) {
    const words = text.split(" ");
    const idx = words.findIndex(w => w.length > 3);
    if (idx !== -1) {
      const original = words[idx];
      words[idx] = original.slice(0, -2) + original.slice(-1) + original.slice(-2, -1); // swap last two letters
      await sendMessageWithTimeout(sock, jid, { text: words.join(" ") }, { quoted: msg });
      await delay(600 + Math.random() * 800);
      await sendMessageWithTimeout(sock, jid, { text: `*${original}` });
      return;
    }
  }

  await sendMessageWithTimeout(sock, jid, { text }, { quoted: msg });
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

    // Only load once per process lifetime — startBot() can recurse on
    // reconnect, and re-loading every time would be wasted Mongo reads.
    if (!statsLoadedOnce) {
      await loadUserStatsFromMongo();
      await loadUserFactsFromMongo();
      await loadGroupConfigsFromMongo();
      statsLoadedOnce = true;
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
    browser: ["Nayla AI", "Chrome", "2.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000
  });

  currentSock = sock; // exposed to the top-level Movie Mode / stats-flush interval

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

  // 🚨 Raid protection — pure local join-rate detection, zero AI cost.
  sock.ev.on("group-participants.update", async (event) => {
    try {
      // Any membership/admin change can affect the bot's OWN admin status in
      // this group — the 10-minute adminCache would otherwise sit stale.
      adminCache.delete(event.id);

      if (event.action === "add") {
        await checkRaidProtection(sock, event.id, event.participants.length);
      }

      if (event.action === "remove") {
        const botWasRemoved = event.participants.some(p => isSelfJid(sock, p));
        if (botWasRemoved) {
          console.log(`🚪 [REMOVED] I was kicked/removed from group ${event.id} — cleaning up its memory.`);
          groupMessageBuffers.delete(event.id);
          groupConfigCache.delete(event.id);
          adminCache.delete(event.id);
          recentRudenessFlag.delete(event.id);
          lastReactionTime.delete(event.id);
          lastAmbientTime.delete(event.id);
          lastEasterEggTime.delete(event.id);
          lastAIReplyTime.delete(event.id);
        }
      }
    } catch (err) {
      console.error("❌ Group participants listener error:", err.message);
    }
  });

  // 📝 Group renamed — just logged for now; cheap to know about, no AI cost,
  // and nothing needs cleaning up since groups are keyed by JID, not name.
  sock.ev.on("groups.update", async (updates) => {
    for (const update of updates) {
      if (update.subject) {
        console.log(`📝 [GROUP RENAME] ${update.id} is now called "${update.subject}"`);
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      let text = sanitizeMentionArtifacts(extractTextFromMessage(msg.message));
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

      // DM-only duplicate-message anti-spam (see checkDuplicateSpam above).
      if (!jid.endsWith("@g.us")) {
        const dupStatus = checkDuplicateSpam(senderJid, text);
        if (dupStatus === "blocked") continue; // already notified, just stay quiet
        if (dupStatus === "just_triggered") {
          await sock.sendMessage(jid, { text: "Whoa, same message 3 times in a row 😅 taking a short 5-minute breather — try me again after that!" }, { quoted: msg }).catch(() => {});
          continue;
        }
      }

      // FIX: .ignore must block EVERYTHING from that person, including their
      // own commands — this now runs BEFORE command routing (it previously
      // ran after, so an ignored user's ".help" or any dot-command still got
      // a response). Also now uses isJidInList (LID-normalized) instead of a
      // raw string .includes() — the raw comparison could silently fail to
      // match the same person stored/arriving in different JID formats,
      // which is why even a plain "nayla" message from an ignored user was
      // slipping through.
      if (jid.endsWith("@g.us")) {
        const ignoreCfg = getGroupConfig(jid);
        if (isJidInList(ignoreCfg.ignoredUsers, senderJid)) continue;
      }

      // Temporary per-user silence from the two-strike shut-up gag — same
      // early position as the permanent ignore check above, for the same
      // reason: total silence toward that one person, everyone else unaffected.
      if (isTemporarilyIgnored(jid, senderJid)) continue;

      // FIX: .mute is now airtight — while muted, the ONLY thing that still
      // works is .unmute itself. Previously this check ran AFTER command
      // routing, so .stats/.ping/any other command still responded while
      // "muted", which wasn't the actual request. Now nothing else gets
      // through at all, not even other recognized commands.
      if (jid.endsWith("@g.us")) {
        const muteCfg = getGroupConfig(jid);
        if (muteCfg.muted && text.toLowerCase().trim() !== ".unmute") {
          continue;
        }
      }

      // --- 0. Command router (.rank, .stats, .lock, .unlock) — handled
      // entirely separately from moderation/AI-chat, zero Groq cost.
      const wasCommand = await handleCommand(sock, jid, senderJid, sender, text, msg);
      if (wasCommand) continue;

      // FIX: anything starting with "." is a command ATTEMPT, recognized or
      // not — never spam/link moderation material. Confirmed bug: Groq's own
      // judgment was reaching unrecognized dot-strings like ".menu" and a
      // lone "." and sometimes misclassifying them as link/spam violations.
      // A moderator wouldn't delete ".menu" — so dot-prefixed text NEVER
      // reaches moderation or chat-reply at all; it just gets a gentle hint.
      if (text.trim().startsWith(".")) {
        const dotCmdVibe = jid.endsWith("@g.us") ? getGroupConfig(jid).mood : BOT_CONFIG.vibe;
        const reply = await generateUnknownCommandReply(text.trim(), dotCmdVibe);
        await sock.sendMessage(jid, { text: reply }, { quoted: msg }).catch(() => {});
        continue;
      }

      // --- Gamification bookkeeping — pure local, no AI cost, runs for
      // every real message including media (harmless, no AI cost).
      bumpUserStats(senderJid, sender);
      const isGroup = jid.endsWith("@g.us");
      if (isGroup) getGroupConfig(jid).messagesReceived++;

      const vibe = isGroup ? getGroupConfig(jid).mood : BOT_CONFIG.vibe;

      // "Addressed" covers a formal @mention, saying "Nayla", OR replying
      // directly to one of the bot's own previous messages. Computed early
      // so the media gate below can use it too.
      const addressed = isGroup && isBotAddressed(sock, msg.message, text);
      const mediaEligible = !isGroup || addressed; // DM = always eligible; group = only if addressed

      // Audio/voice-note understanding: transcribe FIRST (if eligible) so
      // everything downstream — buffering, vibe-check, chat-reply — just
      // sees normal text, exactly as if the person had typed what they said.
      // Ineligible (unaddressed, in a group) voice notes fall through to the
      // existing bare-media skip below, unchanged.
      const incomingMediaType = getMessageMediaType(msg.message);
      if (incomingMediaType === "audio" && mediaEligible) {
        await sock.sendMessage(jid, { text: randomFiller("audio") }, { quoted: msg }).catch(() => {});
        try {
          const audioBuffer = await runHeavyTask(() => downloadMessageMedia(msg));
          if (audioBuffer) {
            const transcription = await runHeavyTask(() => transcribeAudioWithGroq(audioBuffer, "audio/ogg"));
            if (transcription.success && transcription.text) {
              text = transcription.text;
              console.log(`🎙️ [TRANSCRIBE] "${text.slice(0, 80)}"`);
            } else {
              await sock.sendMessage(jid, { text: "🎙️ Couldn't quite make that voice note out — mind typing it instead?" }, { quoted: msg }).catch(() => {});
              continue;
            }
          } else {
            await sock.sendMessage(jid, { text: "🎙️ That voice note didn't come through cleanly on my end — try again?" }, { quoted: msg }).catch(() => {});
            continue;
          }
        } catch (err) {
          if (err.message === "HEAVY_QUEUE_FULL") {
            await sock.sendMessage(jid, { text: "😅 I'm pretty swamped right now — give me a minute and try that voice note again?" }, { quoted: msg }).catch(() => {});
          } else {
            console.error("❌ [TRANSCRIBE] Unexpected error:", err.message);
            await sock.sendMessage(jid, { text: "🎙️ Something went wrong listening to that — try again?" }, { quoted: msg }).catch(() => {});
          }
          continue;
        }
      }

      // Media awareness: ordinary media-sharing (stickers, photos with no
      // caption) that ISN'T addressed to the bot skips the whole pipeline —
      // no vibe-check call, no context buffering. A group that shares a lot
      // of photos shouldn't burn AI calls or fill memory with "[image, no
      // caption]" noise nobody asked about. In a DM, or when addressed, it
      // goes through normally so the bot can honestly say "I don't have eyes
      // yet, what am I looking at?" instead of silently ignoring the person.
      if (isGroup && !addressed && isBareMediaMessage(msg.message)) {
        continue;
      }

      // FIX: DMs previously got ZERO conversation memory — bufferGroupMessage
      // was only ever called `if (isGroup)`, and getRecentContext only ever
      // fed into group replies. That's exactly why a DM quiz broke on plain
      // follow-ups like "B" or "Next" with no @reply attached — the bot had
      // no memory of the question it had just asked. This buffer is keyed by
      // jid regardless of type, so it works identically for DMs; the only
      // group-SPECIFIC consumer (Movie Mode) already filters to @g.us only.
      await bufferGroupMessage(jid, sender, text);

      // FIX: a deliberately huge pasted message could spike token usage on
      // whichever provider handled it enough to trip that provider's OWN
      // rate limit for a long real-world window (confirmed: 50+ minutes) —
      // nothing in this bot's own code was holding it that long, the actual
      // AI provider was. The real fix is never letting oversized text reach
      // any AI call in the first place, for moderation OR chat OR summarize.
      const isOversized = text.length > MAX_AI_INPUT_CHARS;
      // Cheap local toxicity check — independent of any AI call, since the
      // old "warn" action (which used to set this) no longer exists.
      if (isGroup && detectLocalToxicity(text)) {
        recentRudenessFlag.set(jid, Date.now() + RUDENESS_MOOD_DURATION_MS);
      }

      // --- 1. Vibe-check pass: pure optional commentary, NEVER deletes or
      // formally warns (removed entirely per your instruction). Skipped
      // outright for oversized messages — no AI cost wasted commenting on a
      // wall of text nobody will read anyway.
      let evaluation = { comment: "", reaction: "" };
      if (!isOversized) {
        try {
          evaluation = await evaluateMessage(sender, text);
        } catch (sendErr) {
          console.error("❌ Vibe-check pass error:", sendErr.message);
        }
      }

      // --- 2. Conversational AI: ONLY when the bot is tagged/named in a
      // group, or ANY message in a direct 1:1 chat (no one else to address).
      const shouldChatReply = !isGroup || addressed;

      // Reply cooldown — protects the AI provider chain from rapid re-tags
      // and stops the bot from feeling spammy if someone tags it repeatedly.
      const lastReply = lastAIReplyTime.get(jid) || 0;
      const cooledDown = Date.now() - lastReply > AI_REPLY_COOLDOWN_MS;

      if (shouldChatReply && cooledDown) {
        lastAIReplyTime.set(jid, Date.now());

        // FIX: previously fired on ANY message containing "summary"/
        // "summarize" anywhere — including plain questions like "who has a
        // summary of this?" that were never a request TO the bot at all.
        // Now it only counts as a summarize request when there's an actual
        // quoted message attached; otherwise it's just normal conversation
        // (no forced "reply to a message!" refusal for an offhand mention
        // of the word).
        // FIX: quotedText was being passed to generateAIChatReply completely
        // uncapped (only the separate summarize path had a size limit).
        // Confirmed root cause of the "Mistral #3 HTTP 400" reports: someone
        // replied to a massive pasted message in that group, and the FULL
        // text got injected into the prompt, blowing past every provider's
        // payload limits at once. Mistral wasn't uniquely broken — it's just
        // last in the chain, so its error was the one that surfaced after
        // Groq, Cerebras, Gemini, and OpenRouter all failed on the same
        // oversized request. The chain itself was always trying all of them.
        // Highest priority: someone telling the bot to stop/go away. First
        // time, apologize and check in (stays engaged); if the SAME person
        // persists within 10 minutes, actually go quiet toward them for 5
        // minutes with a graceful goodbye. Everyone else in the chat is
        // unaffected — this is per-person, not a whole-chat mute.
        if (SHUT_UP_REGEX.test(text)) {
          const strikeCount = registerShutUpStrike(senderJid);
          if (strikeCount === 1) {
            const checkInLine = await generateShutUpCheckInLine(vibe);
            await sendLikeAHuman(sock, jid, msg, checkInLine);
            if (isGroup) await bufferGroupMessage(jid, BOT_CONFIG.name, checkInLine);
          } else {
            const goodbyeLine = await generateGoQuietLine(vibe);
            await sendLikeAHuman(sock, jid, msg, goodbyeLine);
            setTemporaryIgnore(jid, senderJid);
            shutUpStrikes.delete(senderJid);
            if (isGroup) await bufferGroupMessage(jid, BOT_CONFIG.name, goodbyeLine);
          }
          continue;
        }

        // Image/sticker understanding — Gemini vision, direct media only
        // (a fresh photo/sticker in this exact message, not one being
        // quoted from earlier). Filler message first since this has real
        // network wait time; wrapped in the concurrency limiter so 10
        // groups sending images at once can't overwhelm the container.
        if ((incomingMediaType === "image" || incomingMediaType === "sticker") && mediaEligible) {
          if (incomingMediaType === "sticker" && isAnimatedSticker(msg.message)) {
            await sock.sendMessage(jid, { text: "🎞️ That's an animated sticker — I can only look at still images/stickers for now, not little animations. Send it as a regular photo?" }, { quoted: msg }).catch(() => {});
            continue;
          }
          await sock.sendMessage(jid, { text: randomFiller("vision") }, { quoted: msg }).catch(() => {});
          try {
            const imageBuffer = await runHeavyTask(() => downloadMessageMedia(msg));
            if (imageBuffer) {
              const base64Image = imageBuffer.toString("base64");
              const mimeType = getMessageMimeType(msg.message) || (incomingMediaType === "sticker" ? "image/webp" : "image/jpeg");
              const visionResult = await runHeavyTask(() => analyzeImageWithGemini(base64Image, mimeType, text || null));
              await sendLikeAHuman(sock, jid, msg, visionResult.message);
              if (isGroup) getGroupConfig(jid).responsesSent++;
              if (isGroup && visionResult.success) await bufferGroupMessage(jid, BOT_CONFIG.name, visionResult.message);
            } else {
              await sock.sendMessage(jid, { text: "👀 That image didn't come through cleanly on my end — try sending it again?" }, { quoted: msg }).catch(() => {});
            }
          } catch (err) {
            if (err.message === "HEAVY_QUEUE_FULL") {
              await sock.sendMessage(jid, { text: "😅 I'm pretty swamped right now — give me a minute and try that image again?" }, { quoted: msg }).catch(() => {});
            } else {
              console.error("❌ [VISION] Unexpected error:", err.message);
              await sock.sendMessage(jid, { text: "👀 Something went wrong looking at that — try again?" }, { quoted: msg }).catch(() => {});
            }
          }
          continue;
        }

        const quotedTextRaw = getQuotedMessageText(msg.message);
        const wantsSummary = quotedTextRaw && /\bsummar(y|ise|ize)\b/i.test(text);
        const quotedText = (quotedTextRaw && quotedTextRaw.length > MAX_QUOTED_CONTEXT_CHARS)
          ? quotedTextRaw.slice(0, MAX_QUOTED_CONTEXT_CHARS) + "... [truncated]"
          : quotedTextRaw;
        const feelingSalty = isGroup && (recentRudenessFlag.get(jid) || 0) > Date.now();

        // The 10% "forgot my own owner" gag — narrow trigger (an actual
        // ownership question), rare roll, genuinely AI-varied per request.
        const askingAboutOwner = /\b(who('?s| is)? your owner|who made you|who created you|who owns you|whose bot are you)\b/i.test(text);
        if (askingAboutOwner && Math.random() < 0.10) {
          const confusedLine = await generateConfusedOwnerLine(vibe);
          await sendLikeAHuman(sock, jid, msg, confusedLine);
          await delay(2500 + Math.random() * 2500);
          const corrections = [
            `Ofg sorry, my brain just had a reset 😅 it's ${BOT_CONFIG.creator}!`,
            `Wait — duh, it's ${BOT_CONFIG.creator}. Don't know where that blank came from lol`,
            `...okay I'm back. It's ${BOT_CONFIG.creator}. Weird little glitch there 😅`,
            `Brain reboot complete — ${BOT_CONFIG.creator}, obviously. My bad!`
          ];
          await sock.sendMessage(jid, { text: corrections[Math.floor(Math.random() * corrections.length)] });
          if (isGroup) await bufferGroupMessage(jid, BOT_CONFIG.name, confusedLine);
          continue;
        }

        let aiResult;
        if (wantsSummary) {
          aiResult = await summarizeQuotedText(quotedTextRaw); // summarize gets the FULL text — it has its own separate, larger cap
        } else {
          const context = getRecentContext(jid); // now works identically for DMs and groups
          // FIX: truncate before it ever reaches the AI — same protection
          // as the vibe-check pass, so a giant paste can't blow up a chat
          // reply's token usage/latency either, even when directly addressed.
          const boundedQuestion = isOversized
            ? text.slice(0, MAX_AI_INPUT_CHARS) + "\n[...message was very long, truncated here]"
            : text;

          let searchContext = "";
          if (shouldAutoSearch(text, vibe)) {
            await sock.sendMessage(jid, { text: randomFiller("search") }, { quoted: msg }).catch(() => {});
            try {
              const searchResult = await runHeavyTask(() => searchWeb(boundedQuestion));
              if (searchResult.success && searchResult.results) searchContext = searchResult.results.slice(0, 2500);
            } catch (err) {
              // Search failing (including a full queue) should never block the
              // reply itself — just proceed without search grounding.
              console.warn("⚠️ [SEARCH] Auto-search unavailable:", err.message);
            }
          }

          aiResult = await generateAIChatReply(senderJid, sender, boundedQuestion, vibe, context, quotedText, feelingSalty, searchContext, jid);
        }

        try {
          await sendLikeAHuman(sock, jid, msg, aiResult.message, aiResult.allowEmoji);
          console.log(aiResult.success
            ? `💬 AI-replied to ${sender} successfully.`
            : `⚠️ Sent AI-failure notice to ${sender} (see error above).`);
          if (isGroup) getGroupConfig(jid).responsesSent++;
          // The bot's own replies get recorded too, so it has memory of
          // what IT said, not just what everyone else said.
          if (isGroup && aiResult.success) await bufferGroupMessage(jid, BOT_CONFIG.name, aiResult.message);
        } catch (sendErr) {
          console.error("❌ Failed sending AI chat reply:", sendErr.message);
        }
      } else if (shouldChatReply && !cooledDown) {
        console.log(`⏱️ [COOLDOWN] Skipped AI reply to ${sender} — too soon since last reply in this chat.`);
      } else if (isGroup) {
        // "Group Soul": the bot isn't being addressed, so this is the only
        // place its rare ambient touches get a chance — a reaction and/or a
        // one-line comment on something notable (a link, gibberish, drama),
        // piggybacked on the vibe-check call that ALREADY ran above (zero
        // extra AI requests), rare by prompt instruction AND cooldown-gated
        // here so an overeager model can't make it naggy. NEVER deletes or
        // warns — comments only, exactly as requested.
        if (evaluation.reaction && Date.now() - (lastReactionTime.get(jid) || 0) > REACTION_COOLDOWN_MS) {
          lastReactionTime.set(jid, Date.now());
          sock.sendMessage(jid, { react: { text: evaluation.reaction, key: msg.key } }).catch(() => {});
        }
        if (evaluation.comment && Date.now() - (lastAmbientTime.get(jid) || 0) > AMBIENT_COOLDOWN_MS) {
          lastAmbientTime.set(jid, Date.now());
          sock.sendMessage(jid, { text: evaluation.comment }).catch(() => {});
        }
        maybeFireEasterEgg(sock, jid).catch(() => {});
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