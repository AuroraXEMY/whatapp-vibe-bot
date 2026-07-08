/**
 * WhatsApp Bot QR Code Authorization Utility (Anti-Fail Resiliency Edition)
 * 
 * SOLE PURPOSE: Securely authenticate with your WhatsApp account using a terminal QR code,
 * download and save session credentials, and sync them to your MongoDB Database.
 * Once completed, this script exits and you run 'npm start' to run the main bot!
 * 
 * Features:
 * - Automatically terminates after 3 unsuccessful QR code generation/scans or connection failures.
 */

const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  Browsers,
  delay 
} = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
require("dotenv").config();

// trapping exceptions with detailed debugger
process.on("uncaughtException", (err) => {
  console.error("🔥 [DEBUGGER ERROR] Caught exception:", err.message);
  console.error(err.stack);
});

const MONGO_URI = process.env.MONGODB_URI;

// Model to store session keys in MongoDB (Cloud Sync)
const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  data: { type: String, required: true }
});
const Session = mongoose.models.Session || mongoose.model("Session", SessionSchema);

async function uploadSessionToMongo(authFolder) {
  if (!MONGO_URI) {
    console.log("⚠️ No MONGODB_URI set, skipping cloud upload. Session will only be saved locally.");
    return;
  }
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

let qrAttempts = 0;
let connectionFailures = 0;

async function runPairing() {
  console.log("==================================================");
  console.log("⚡ VIBEGUARD WHATSAPP QR-CODE WIZARD INITIALIZING");
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
  
  // Clean local session_auth directory for fresh, absolute clean start (eliminates stale conflicts!)
  if (fs.existsSync(authFolder)) {
    console.log("🧹 Found existing local 'session_auth' folder. Clearing for a clean pairing session...");
    fs.rmSync(authFolder, { recursive: true, force: true });
  }
  fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  console.log("⏳ Establishing Baileys connection to WhatsApp servers...");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // We print manually to control attempts and design
    logger: pino({ level: "info" }), // Set to info to see exactly what is happening during connection handshake!
    browser: Browsers.windows("Chrome"),
    syncFullHistory: false,
    connectTimeoutMs: 60000
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 1. Handle QR Code Generation with Hard Anti-Fail Limit of 3
    if (qr) {
      qrAttempts++;
      if (qrAttempts > 3) {
        console.error("\n❌ [PAIRING FAILED] Generated QR Code 3 times without any scan or link. Terminating to prevent hanging...");
        try { await mongoose.connection.close(); } catch (e) {}
        process.exit(1);
      }

      console.log("\n==================================================");
      console.log(`📸  WHATSAPP BOT QR CODE (ATTEMPT ${qrAttempts} / 3)`);
      console.log("==================================================");
      qrcode.generate(qr, { small: true });
      console.log("==================================================");
      console.log("👉 Go to: WhatsApp > Linked Devices > Link a Device.");
      console.log("👉 Scan the QR code above with your phone!");
      console.log("⏳ Waiting for scan... Script will auto-exit on successful link.");
      console.log("==================================================\n");
    }

    // 2. Handle Connection Closure / Disconnect Errors with Hard Anti-Fail Limit of 3
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`⚠️ Connection closed. Status Code: ${statusCode}. Reconnect allowed: ${shouldReconnect}`);
      
      connectionFailures++;
      if (connectionFailures >= 3) {
        console.error("\n❌ [LINKING FAILED] Encountered 3 successive connection/handshake failures. Terminating to protect resources...");
        try { await mongoose.connection.close(); } catch (e) {}
        process.exit(1);
      }

      if (shouldReconnect) {
        console.log("🔄 Re-initializing connection to continue pairing process in 5 seconds...");
        await delay(5000);
        runPairing();
      } else {
        console.error("❌ WhatsApp permanently rejected this pairing attempt. Please clear auth files and try again.");
        try { await mongoose.connection.close(); } catch (e) {}
        process.exit(1);
      }
    } 
    // 3. Handle Successful Connection
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
}

runPairing();
