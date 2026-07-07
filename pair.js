/**
 * WhatsApp Bot Pairing Authorization Utility
 * 
 * SOLE PURPOSE: Securely authenticate with your WhatsApp account using a pairing code,
 * download and save session credentials, and sync them to your MongoDB Database.
 * Once completed, this script exits and you run 'npm start' to run the main bot!
 */

const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  delay 
} = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// trapping exceptions with detailed debugger
process.on("uncaughtException", (err) => {
  console.error("🔥 [DEBUGGER ERROR] Caught exception:", err.message);
  console.error(err.stack);
  if (err.message.includes("405") || err.message.includes("428") || err.message.includes("Connection Closed")) {
    console.log("\n🔎 --- PAIRING DIAGNOSIS & SOLUTIONS ---");
    console.log("1. STALE MongoDB DATA: Please open your MongoDB Atlas dashboard, delete the 'sessions' collection entirely, and run pairing again.");
    console.log("2. STALE local folder: Delete the './session_auth' folder completely and retry.");
    console.log("3. COUNTRY CODE MISSING: Ensure process.env.PHONE_NUMBER contains the full international country code (e.g., 2348012345678, not + or spaces).");
    console.log("4. STACK CONFLICTS: Ensure you aren't running index.js and pair.js at the same time! Close other terminals.");
    console.log("------------------------------------------\n");
  }
});

const MONGO_URI = process.env.MONGODB_URI;
const phoneNum = process.env.PHONE_NUMBER;

if (!phoneNum) {
  console.error("❌ PHONE_NUMBER environment variable is missing in your .env configuration!");
  console.log("👉 Setup Guide: Open your .env file or Render secrets and set PHONE_NUMBER to your full number with country code (e.g., 2348012345678, no + or spaces).");
  process.exit(1);
}

// Model to store session keys in MongoDB (Cloud Sync)
const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  data: { type: String, required: true }
});
const Session = mongoose.models.Session || mongoose.model("Session", SessionSchema);

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
    console.log("💾 Active session successfully uploaded to MongoDB Atlas Cluster! 🔒");
  } catch (err) {
    console.error("❌ Failed to sync session to MongoDB:", err.message);
  }
}

async function runPairing() {
  console.log("==================================================");
  console.log("⚡ VIBEGUARD WHATSAPP PAIRING WIZARD INITIALIZING");
  console.log("==================================================");

  if (MONGO_URI) {
    try {
      console.log("🔌 Connecting to MongoDB Atlas Database...");
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
      });
      console.log("✅ MongoDB Connection Successful.");
    } catch (dbErr) {
      console.error("❌ MongoDB connection failed. Running pairing in local-only mode:", dbErr.message);
    }
  } else {
    console.log("⚠️ MONGODB_URI is not set. Storing session locally only.");
  }

  const authFolder = "./session_auth";
  
  // Clean local session_auth directory for fresh, absolute clean start (eliminates 405 stale conflicts!)
  if (fs.existsSync(authFolder)) {
    console.log("🧹 Found existing local 'session_auth' folder. Clearing for a clean pairing session...");
    fs.rmSync(authFolder, { recursive: true, force: true });
  }
  fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  console.log("⏳ Establishing Baileys connection to WhatsApp servers...");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["VibeGuard AI", "Chrome", "2.0.0"],
    syncFullHistory: false,
    connectTimeoutMs: 60000
  });

  let pairingCodeRequested = false;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`⚠️ Connection closed. Status Code: ${statusCode}. Reconnect allowed: ${shouldReconnect}`);
      
      if (statusCode === 428 || statusCode === 405) {
        console.log("\n🔎 --- DIAGNOSTIC HELP ---");
        console.log("If you receive status code 405/428, it usually indicates a conflict or invalid credentials state.");
        console.log("POSSIBLE CAUSES & REMEDIES:");
        console.log("1. Multi-Device session clash: Make sure the main bot (index.js) isn't running at the same time!");
        console.log("2. Stale local credentials: We have already cleared the 'session_auth' directory. If error persists,");
        console.log("   please open your MongoDB Atlas database, clear the 'sessions' collection, and run this pairing script again.");
        console.log("-----------------------------\n");
      }

      if (shouldReconnect) {
        console.log("🔄 Re-initializing connection to continue pairing process in 5 seconds...");
        await delay(5000);
        runPairing();
      } else {
        console.error("❌ WhatsApp permanently rejected this pairing attempt. Please check your number and try again.");
        process.exit(1);
      }
    } 
    else if (connection === "open") {
      console.log("\n==================================================");
      console.log("🎉 SUCCESS: WHATSAPP ACCOUNT LINKED & AUTHENTICATED!");
      console.log("==================================================");
      console.log("💾 Syncing local credentials files to MongoDB Atlas...");
      
      await saveCreds();
      await uploadSessionToMongo(authFolder);
      
      console.log("\n✅ BOT IS FULLY LOGGED IN AND READY! 🚀");
      console.log("👉 Step 3: Run 'npm start' to boot up your persistent moderator bot!");
      console.log("==================================================\n");
      
      try {
        await mongoose.connection.close();
      } catch (e) {}
      process.exit(0);
    }
  });

  // Request the pairing code after socket loads
  setTimeout(async () => {
    if (pairingCodeRequested || sock.authState.creds.registered) return;
    pairingCodeRequested = true;

    console.log("🔑 Requesting pairing code for number: " + phoneNum);
    const sanitizedNumber = phoneNum.replace(/[^0-9]/g, "");

    try {
      let code = await sock.requestPairingCode(sanitizedNumber);
      code = code?.match(/.{1,4}/g)?.join("-") || code;
      
      console.log("\n==================================================");
      console.log("🔑  WHATSAPP BOT PAIRING CODE GENERATED SUCCESS");
      console.log(`👉  \x1b[1;35m${code}\x1b[0m  👈`);
      console.log("==================================================");
      console.log("Go to: Linked Devices > Link with Phone Number in WhatsApp!");
      console.log("👉 Input the code above on your phone.");
      console.log("⏳ Waiting for user to complete linking device... DO NOT CLOSE THIS TERMINAL!");
      console.log("==================================================\n");
    } catch (err) {
      console.error("❌ Failed to generate pairing code:", err.message);
      console.log("💡 Tip: Double check your PHONE_NUMBER environment variable in .env (e.g. 2348012345678). Avoid using special characters or '+' signs!");
      process.exit(1);
    }
  }, 4000);
}

runPairing();