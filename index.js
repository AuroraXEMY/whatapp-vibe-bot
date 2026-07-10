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

const LINK_COMMENTS = [
  "Jeez, I hope this link doesn't lead me to hell 😭",
  "Ooh a link! Not clicking that with my whole chest 😅",
  "A mysterious link appears... proceed with caution 👀",
  "Sending a link and no context? Bold move 😏"
];
const GIBBERISH_COMMENTS = [
  "Seems like someone's smashing their keyboard 😭",
  "I felt that keyboard rage from here 💀",
  "Understood absolutely none of that, but I respect the energy",
  "That's a whole lot of nothing, but go off 😂"
];

// Funny, personalized "that's not a real command" replies — references the
// actual thing they typed instead of a flat generic error. Zero AI cost.
const UNKNOWN_COMMAND_TEMPLATES = [
  (cmd) => `lol, we don't have a *${cmd}* command here, wanna explode the universe instead? 🤣`,
  (cmd) => `*${cmd}*? Bold of you to assume I have that installed 😂 try *.help*`,
  (cmd) => `404: *${cmd}* not found in my brain. Try *.help* for the stuff I actually do.`,
  (cmd) => `I wish *${cmd}* was a real thing I could do. Alas. *.help* has what I've actually got.`
];
function unknownCommandReply(rawCmd) {
  const cmd = rawCmd.split(/\s+/)[0];
  const template = UNKNOWN_COMMAND_TEMPLATES[Math.floor(Math.random() * UNKNOWN_COMMAND_TEMPLATES.length)];
  return template(cmd);
}

// NEVER deletes or formally warns — used only when Groq/Cerebras/Mistral are
// all unavailable, so the bot can still occasionally comment on something
// notable (a link, obvious keyboard-mashing) without needing any AI call.
function fallbackLocalModerate(text) {
  if (detectLink(text) && Math.random() < 0.35) {
    return { comment: LINK_COMMENTS[Math.floor(Math.random() * LINK_COMMENTS.length)], reaction: "" };
  }
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
    lastAIReplyTime.clear();
    recentJoins.clear();
    recentRudenessFlag.clear();
    lastReactionTime.clear();
    lastAmbientTime.clear();
    lastEasterEggTime.clear();
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

function getUserStats(jid) {
  if (!userStatsCache.has(jid)) {
    userStatsCache.set(jid, { displayName: "Anonymous", xp: 0, messageCount: 0, facts: [], lastActive: new Date(), dirty: true });
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

function addUserFact(jid, fact) {
  if (!fact || !fact.trim()) return;
  const stats = getUserStats(jid);
  const clean = fact.trim().slice(0, 120);
  if (stats.facts.includes(clean)) return;
  stats.facts.push(clean);
  if (stats.facts.length > 5) stats.facts.shift(); // cap to last 5 — bounds both memory and prompt size
  stats.dirty = true;
}

// Batch-flush ONLY changed user stats to Mongo periodically — avoids a write
// on every single message, which would hammer the free Mongo tier for data
// this low-stakes (XP/facts, not moderation state).
async function flushUserStatsToMongo() {
  if (!MONGO_URI) return;
  const dirtyEntries = [...userStatsCache.entries()].filter(([, s]) => s.dirty);
  if (dirtyEntries.length === 0) return;

  for (const [jid, stats] of dirtyEntries) {
    try {
      await UserStat.findOneAndUpdate(
        { jid },
        { displayName: stats.displayName, xp: stats.xp, messageCount: stats.messageCount, facts: stats.facts, lastActive: stats.lastActive },
        { upsert: true }
      );
      stats.dirty = false;
    } catch (err) {
      console.error(`❌ Failed flushing stats for ${jid}:`, err.message);
    }
  }
  console.log(`💾 [STATS] Flushed ${dirtyEntries.length} updated user profile(s) to MongoDB.`);
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
        facts: doc.facts || [],
        lastActive: doc.lastActive || new Date(),
        dirty: false
      });
    }
    console.log(`📥 [STATS] Loaded ${all.length} existing user profile(s) from MongoDB.`);
  } catch (err) {
    console.error("❌ Failed loading user stats from MongoDB:", err.message);
  }
}

function getGroupConfig(jid) {
  if (!groupConfigCache.has(jid)) {
    groupConfigCache.set(jid, { locked: false, lastRecapDate: null, mood: "cool", dirty: false });
  }
  return groupConfigCache.get(jid);
}

async function persistGroupConfig(jid) {
  if (!MONGO_URI) return;
  const cfg = getGroupConfig(jid);
  try {
    await GroupConfig.findOneAndUpdate(
      { jid },
      { locked: cfg.locked, lastRecapDate: cfg.lastRecapDate, mood: cfg.mood },
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
      groupConfigCache.set(doc.jid, { locked: !!doc.locked, lastRecapDate: doc.lastRecapDate || null, mood: doc.mood || "cool", dirty: false });
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
  return buf.slice(-limit).map(m => `${m.sender}: ${m.text}`).join("\n");
}

// --- 🎬 Movie Mode: ONE AI call per group per day, never per-message ---
async function maybeGenerateMovieRecap(sock) {
  if (!sock || PROVIDER_CHAIN.length === 0) return;
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  for (const [jid, buffer] of groupMessageBuffers.entries()) {
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
    const participant = groupMetadata.participants.find(p => p.id.split(":")[0].split("@")[0] === senderNumber);
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
        text: `🤖 *${BOT_CONFIG.name} Commands*\n\n*Everyone:*\n.rank / .level — your XP & title\n.stats — bot health\n.mood — show current personality\n.about — what I am\n.owner — who made me\n.ping / .flip / .roll [sides] / .8ball — quick fun stuff\n\n*Group admins only:*\n.lock / .unlock — restrict messaging to admins\n.mood <name> — change personality (${AVAILABLE_MOODS.join(", ")})\n.kick (reply or @mention) — remove a member\n.promote / .demote (reply or @mention) — admin toggle\n.tagall — mention everyone\n.del (reply to a message) — delete it\n\nTag me or say my name to chat, or reply "Nayla summarize this" onto a long message! Heads up: I'm a vibe bot, not a moderator — I don't delete stuff or hand out formal warnings, ever.`
      }, { quoted: msg });
      return true;
    }

    if (cmd === ".about") {
      await sock.sendMessage(jid, {
        text: `🤖 *About ${BOT_CONFIG.name}*\n\nI'm a WhatsApp companion bot — I chat, vibe, remember little things about you, and occasionally comment on chaos in the group. I do NOT delete messages or moderate anything; I'm just here for the energy.\n\nUnder the hood: Baileys for WhatsApp, a chain of AI providers (with automatic backups if one's busy), and MongoDB for memory — all running on a cloud server my creator pays for, so be nice to them.\n\nType *.owner* to see who that is, or *.help* for what I can do.`
      }, { quoted: msg });
      return true;
    }

    if (cmd === ".owner") {
      await sock.sendMessage(jid, {
        text: `👑 My creator and owner is *${BOT_CONFIG.creator}*. They built me, they host me, they keep the lights on — direct all compliments (and bug reports) their way 😎`
      }, { quoted: msg });
      return true;
    }

    if (jid.endsWith("@g.us") && (cmd === ".kick" || cmd === ".promote" || cmd === ".demote")) {
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
      await sock.groupParticipantsUpdate(jid, [target], actionMap[cmd]);
      const label = { ".kick": "removed 👋", ".promote": "promoted to admin 🎖️", ".demote": "demoted from admin" }[cmd];
      await sock.sendMessage(jid, { text: `✅ @${target.split("@")[0]} ${label}.`, mentions: [target] });
      console.log(`✅ [${cmd}] ${sender} used ${cmd} on ${target} in ${jid}.`);
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
  facts: { type: [String], default: [] }, // capped to last 5 in code
  lastActive: Date
});
const UserStat = mongoose.models.UserStat || mongoose.model("UserStat", UserStatSchema);

const GroupConfigSchema = new mongoose.Schema({
  jid: { type: String, required: true, unique: true },
  locked: { type: Boolean, default: false },
  lastRecapDate: String, // "YYYY-MM-DD" of the last Movie Mode recap sent
  mood: { type: String, default: "cool" } // per-group personality override
});
const GroupConfig = mongoose.models.GroupConfig || mongoose.model("GroupConfig", GroupConfigSchema);

// Archived "active memory" dumps — written once a group's rolling 50-message
// buffer fills up, then the live buffer resets. Not meant to be re-loaded
// into memory; just a durable record so nothing's silently lost.
const ConversationArchiveSchema = new mongoose.Schema({
  jid: String,
  transcript: [String],
  archivedAt: Date
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
const AVAILABLE_MOODS = ["cool", "gen_z", "strict_mod", "playful", "sarcastic", "flirty", "motivational", "empathic", "inquisitive", "chill", "therapist", "professor", "grandma"];
const MOOD_DESCRIPTIONS = {
  cool: "slang, chilling, 😎, 🌴.",
  gen_z: "lowercase, sarcastic, bruh, 💀, 😭.",
  strict_mod: "extremely polite, firm, warning template, 🚫.",
  playful: "lighthearted, teasing, loves jokes and puns, 😄🤪.",
  sarcastic: "dry wit, deadpan comebacks, playful jabs — never actually mean, 🙄😏.",
  flirty: "warm, charming, complimentary banter — always PG, never explicit, 😉💫.",
  motivational: "upbeat, encouraging, hypes people up, believes in you, 💪✨.",
  empathic: "warm and gentle, validates feelings first, checks in on people, 🤍.",
  inquisitive: "curious, asks good follow-up questions to keep the chat going, 🤔💭.",
  chill: "relaxed, unbothered, short low-effort replies, nothing fazes it, 😌.",
  therapist: "calm and reflective, asks thoughtful open questions, never judgmental, 🌿.",
  professor: "a genuine over-explainer who can't resist a tangent — even a plain 'hello' gets met with an obscure fact (e.g. word origins, history) before actually answering; articulate, a little formal, clearly loves teaching, 🎓📚.",
  grandma: "sweet and doting, old-fashioned turns of phrase, worries if you've eaten, 🧶🍪."
};
function describeMood(vibe) {
  return MOOD_DESCRIPTIONS[vibe] || MOOD_DESCRIPTIONS.cool;
}

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
  for (let i = 1; i <= 3; i++) {
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

async function callAIProvider(messages, { json = false, temperature = 0.5, timeoutMs = 12000 } = {}) {
  if (PROVIDER_CHAIN.length === 0) {
    const err = new Error("NO_PROVIDERS_CONFIGURED");
    err.status = 401;
    throw err;
  }

  let lastErr = null;
  for (const provider of PROVIDER_CHAIN) {
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
          ...(json ? { response_format: { type: "json_object" } } : {})
        })
      });
      if (!response.ok) {
        const err = new Error(`${provider.name} returned HTTP ${response.status}`);
        err.status = response.status;
        err.provider = provider.name;
        throw err;
      }
      const data = await response.json();
      return data.choices[0].message.content;
    })();

    try {
      const text = await Promise.race([callPromise, timeoutPromise]);
      if (provider.name !== "Groq") console.log(`✅ [PROVIDER FAILOVER] ${provider.name} handled this request after an earlier provider failed.`);
      return text;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️ [PROVIDER FAILOVER] ${provider.name} failed (${err.message}) — trying next provider...`);
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

Sometimes — rarely — you playfully comment on something notable in a message: a link ("hope this doesn't lead me to hell 😭"), obvious gibberish/keyboard-smashing, or something genuinely funny/surprising. If a message seems hurtful/toxic toward someone, respond warmly and supportively instead of scolding — check in on them like a friend would, don't lecture like a Reddit mod.
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
  const quotedParticipant = content?.extendedTextMessage?.contextInfo?.participant;
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
async function generateAIChatReply(senderJid, sender, question, vibe = BOT_CONFIG.vibe, context = "", quotedText = null, feelingSalty = false) {
  if (PROVIDER_CHAIN.length === 0) {
    console.error("🔴 [AI CHAT] No AI providers configured (GROQ_API_KEY / CEREBRAS_API_KEY_1-3 / MISTRAL_API_KEY all missing).");
    return { success: false, message: "🔑 My whole brain is unplugged right now (no AI provider keys configured) — my developer needs to fix that." };
  }

  const stats = getUserStats(senderJid);
  const knownFacts = stats.facts.length > 0 ? stats.facts.join("; ") : "nothing yet";

  // Rare (5%) personality quirk: fixate on one random non-essential word in
  // their message instead of fully engaging — pure prompt variation, zero
  // extra cost or stored state.
  const distracted = Math.random() < 0.05;

  const callPromise = (async () => {
    const systemPrompt = `You are ${BOT_CONFIG.name}, a WhatsApp group companion with a "${vibe}" personality.
${describeMood(vibe)}

Self-awareness (know this about yourself, bring it up naturally/funnily if asked — never say "no one hosts me" or that you're just floating around):
- You were built and are hosted by your creator, ${BOT_CONFIG.creator}, on a cloud server (Render or similar) — you don't need deep infra details, just that a real person made and runs you.
- You do NOT have the ability to download videos/images/audio/files, generate or edit images, browse the internet, or send media — if asked for any of that, decline in an intelligent, funny, in-character way instead of a flat "I can't do that" (e.g. riff on it, don't just refuse).
- If someone asks for something absurd (like "give me a million dollars"), respond with humor, not a flat refusal.
- If you don't recognize a request as something you can do, make a joke about it rather than sounding broken or confused.

What you already remember about ${sender}: ${knownFacts}.
${context ? `Recent conversation in this chat (for context only, don't repeat it back verbatim):\n${context}\n` : ""}${quotedText ? `IMPORTANT: ${sender} is directly replying to this specific earlier message — "${quotedText}" — answer THEIR question about/reaction to THAT message, don't ask what they mean.\n` : ""}${feelingSalty ? `Note: there's been some rudeness in this chat in the last few minutes — you're allowed to sound a little annoyed/short about it, without being genuinely mean or holding a real grudge.\n` : ""}${distracted ? `Quirk for THIS reply only: humans sometimes get hung up on one random, non-essential word/noun in what someone said instead of the main point. Just this once, playfully latch onto one such word from their message first, THEN still briefly address their actual point too — e.g. "Honeycrisp or Granny Smith? Also yeah, send the code."\n` : ""}
Reply naturally and in character, 1-4 sentences, weaving in what you remember about them ONLY where it fits naturally — don't force it every time.
Do not mention you are an AI model unless directly asked. Never store or repeat sensitive personal info (health, address, financial details).

Respond ONLY with a raw JSON object matching this schema, no other text:
{
  "reply": "your in-character reply text",
  "newFact": "one short new casual/non-sensitive fact worth remembering about this person from this message, or an empty string if nothing notable"
}`;

    const raw = await callAIProvider([
      { role: "system", content: systemPrompt },
      { role: "user", content: `${sender} said: "${question}"` }
    ], { json: true, temperature: 0.8, timeoutMs: 15000 });

    let cleanText = raw.trim();
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```json?/, "").replace(/```$/, "").trim();
    }
    return JSON.parse(cleanText);
  })();

  try {
    const result = await callPromise;
    aiFailStreak = 0;
    if (result.newFact) addUserFact(senderJid, result.newFact);
    return { success: true, message: result.reply };
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
  const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return null;
  const text = extractTextFromMessage(quoted);
  return text && text.trim().length > 0 ? text.trim() : null;
}

// Resolves who a moderation command (.kick/.promote/.demote) targets: prefer
// whoever's message is being replied to, otherwise the first @mention.
function resolveCommandTarget(message) {
  const content = unwrapMessageContent(message);
  const contextInfo = content?.extendedTextMessage?.contextInfo;
  if (contextInfo?.participant) return contextInfo.participant;
  if (contextInfo?.mentionedJid?.length > 0) return contextInfo.mentionedJid[0];
  return null;
}

// Builds the message key .del needs to delete a REPLIED-TO message (requires
// the bot to be a group admin to delete someone else's message).
function resolveQuotedMessageKey(jid, message) {
  const content = unwrapMessageContent(message);
  const contextInfo = content?.extendedTextMessage?.contextInfo;
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

// Adds a human touch to AI-generated replies: a brief "typing..." presence
// scaled to reply length (capped so it's never actually laggy), and a rare
// (2%) deliberate typo followed by a quick "*correction" — both timing/
// randomness only, zero stored state, zero RAM cost.
async function sendLikeAHuman(sock, jid, msg, text) {
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
      await sock.sendMessage(jid, { text: words.join(" ") }, { quoted: msg });
      await delay(600 + Math.random() * 800);
      await sock.sendMessage(jid, { text: `*${original}` });
      return;
    }
  }

  await sock.sendMessage(jid, { text }, { quoted: msg });
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
      // FIX: any membership/admin change can affect the bot's OWN admin
      // status in this group (e.g. someone just ran .promote on it). The
      // 10-minute adminCache would otherwise sit stale for up to 10 minutes
      // after a real promotion — exactly the "doesn't recognize it's an
      // admin... well, after some time, it works" symptom. That "after some
      // time" WAS the stale cache finally expiring, not a detection bug.
      adminCache.delete(event.id);

      if (event.action === "add") {
        await checkRaidProtection(sock, event.id, event.participants.length);
      }
    } catch (err) {
      console.error("❌ Raid protection listener error:", err.message);
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      const text = sanitizeMentionArtifacts(extractTextFromMessage(msg.message));
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
        await sock.sendMessage(jid, { text: unknownCommandReply(text.trim()) }, { quoted: msg }).catch(() => {});
        continue;
      }

      // --- Gamification + Movie Mode bookkeeping — pure local, no AI cost.
      bumpUserStats(senderJid, sender);
      const isGroup = jid.endsWith("@g.us");
      const vibe = isGroup ? getGroupConfig(jid).mood : BOT_CONFIG.vibe;
      if (isGroup) await bufferGroupMessage(jid, sender, text);

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
      // "Addressed" covers a formal @mention, saying "Nayla", OR replying
      // directly to one of the bot's own previous messages.
      const addressed = isGroup && isBotAddressed(sock, msg.message, text);
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
        const quotedText = getQuotedMessageText(msg.message);
        const wantsSummary = quotedText && /\bsummar(y|ise|ize)\b/i.test(text);
        const feelingSalty = isGroup && (recentRudenessFlag.get(jid) || 0) > Date.now();

        let aiResult;
        if (wantsSummary) {
          aiResult = await summarizeQuotedText(quotedText);
        } else {
          const context = isGroup ? getRecentContext(jid) : "";
          // FIX: truncate before it ever reaches the AI — same protection
          // as the vibe-check pass, so a giant paste can't blow up a chat
          // reply's token usage/latency either, even when directly addressed.
          const boundedQuestion = isOversized
            ? text.slice(0, MAX_AI_INPUT_CHARS) + "\n[...message was very long, truncated here]"
            : text;
          aiResult = await generateAIChatReply(senderJid, sender, boundedQuestion, vibe, context, quotedText, feelingSalty);
        }

        try {
          await sendLikeAHuman(sock, jid, msg, aiResult.message);
          console.log(aiResult.success
            ? `💬 AI-replied to ${sender} successfully.`
            : `⚠️ Sent AI-failure notice to ${sender} (see error above).`);
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