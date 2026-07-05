# VibeGuard AI Moderator Bot (v2.4.0) 😎🤖

Professional, enterprise-resilient WhatsApp group moderator bot designed to run 24/7 on resource-constrained hosting services like **Render (Free Tier - 512MB RAM)** or **Termux**. Armed with a **12-Tier Resiliency Guard** that makes it virtually bulletproof to spam floods and AI connection drops, and supports **Pairing Code Login** so you don't need to scan QR codes on server logs!

---

## ⚡ 12-Tier Crash and Resiliency Protections
This bot incorporates top-tier corporate developer patterns to operate seamlessly within Render's strict **512MB RAM free limit**:
1. **Uncaught Crash Traps**: Global listeners catch uncaught exceptions, preventing random network/WS errors from killing the bot process.
2. **Serial API Request Queue**: Moderation requests are throttled and handled through a single sequential queue, stopping parallel AI tasks from bloating Node's RAM and triggering Out-Of-Memory (OOM) crashes.
3. **Leaky-Bucket Rate Limiter**: Spammers spamming dozens of messages are instantly rate-limited per chat/user, bypassing Gemini to conserve limits.
4. **Memory Heap Monitor**: Automatically tracks RAM allocation. If memory gets close to limits (>380MB), it clears logs, limits queues, and flushes rate-limiter maps preventatively.
5. **Circuit Breaker Outage Handler**: If the Gemini API suffers an outage or severe latency, the bot automatically switches off Gemini and activates local engines to keep group chats safe.
6. **Zero-Latency Fallback Engine**: Fully functional offline local moderator evaluates links, flood lengths, and custom triggers with lightning-fast regex patterns when Gemini is cool-down caching.
7. **Exponential Backoff Reconnector**: Dynamically calculates connection retry pauses up to 45s to avoid IP bans or rate limit blocks from WhatsApp.
8. **Group Admin Caching**: Caches group admin rules for 10 minutes to avoid querying heavy WhatsApp metadata on every single message.
9. **Safe Send Wrapper**: All sendMessage and deleteMessage requests are safe-wrapped to prevent missing admin permissions from throwing uncaught thread errors.
10. **JSON Syntax Cleaner**: Safely sanitizes raw markdown return blocks from Gemini to ensure clean string conversion.
11. **Graceful Container Shutdown**: Catches SIGTERM / SIGINT to cleanly disconnect MongoDB and WhatsApp sync before the Render container sleeps.
12. **Database Timeout Guard**: MongoDB connections have a strict 10s timeout, falling back automatically to local file sessions if Atlas experiences temporary hiccups.

---

## 🔑 Step 1: Getting Your Pairing Code (No QR Scan Needed)
Pairing with a phone number is the easiest way to log in. No terminal QR scanning required!

1. Open your code's `.env` file (locally or on Render's Environment variables screen).
2. Set the `PHONE_NUMBER` variable containing your country code without special characters (e.g., `2348012345678`).
3. Boot the bot (`npm start`).
4. Watch the console logs! In 4 seconds, a secure hyphenated **Pairing Code** will be printed (e.g., `A1B2-C3D4`).
5. Open **WhatsApp on your phone > Settings / Menu > Linked Devices > Link a Device > Link with phone number instead**.
6. Type the Pairing Code printed in your logs! Your session is instantly active and synced to MongoDB.

---

## ☁️ Step 2: Render.com Cloud Deployment Guide (Full Tutorial)

Because Render containers are ephemeral (they clear stored files on restarts), **MongoDB Atlas** is used to store active login credentials. Once paired, the bot will auto-download session files and remain online 24/7 without scanning!

### 1. Set Up MongoDB Atlas (Free State Storage)
1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) and register a free account.
2. Create a Free Cluster (Shared Tier).
3. Under **Database Access**, create a user with a simple, secure password (e.g. `bot_user`). Keep it safe!
4. Under **Network Access**, click **Add IP Address** and set it to `0.0.0.0/0` (this is critical so Render's changing IPs can connect).
5. On your Cluster page, click **Connect > Drivers**, and copy your **connection string** (e.g., `mongodb+srv://...`).
6. Replace `<password>` in your connection string with your database user password.

### 2. Set Up Your Private GitHub Repository
When deploying from phone or Termux to Render, creating and using a GitHub repository is required.
1. Create a free account on [GitHub.com](https://github.com).
2. Go to your GitHub profile menu and select **Settings > Developer Settings > Personal Access Tokens > Tokens (classic)**.
3. Generate a token, check the `repo` scope box, and copy the **GitHub Personal Access Token (PAT)**. (This is what you'll use as your Git password when pushing from Termux!).
4. Go back to GitHub and create a new **Private** repository named `whatsapp-vibe-bot`.
5. On your local machine or Termux, push your code files:
   ```bash
   git init
   # Create a .gitignore to make sure we never publish secret credentials!
   echo "node_modules/" >> .gitignore
   echo "session_auth/" >> .gitignore
   echo ".env" >> .gitignore
   
   git add .
   git commit -m "deploying robust VibeGuard bot v2.4.0"
   git branch -M main
   # Set your remote origin URL
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/whatsapp-vibe-bot.git
   git push -u origin main
   # Enter your GitHub username. When prompted for password, paste your GitHub PAT!
   ```

### 3. Deploy 24/7 on Render (Free Tier)
1. Sign up on [Render.com](https://render.com) using your GitHub login.
2. Click **New +** at the top right and select **Background Service**. (Do NOT select Web Service — background services run WhatsApp sockets silently without needing public ports).
3. Find your `whatsapp-vibe-bot` repository in the list and click **Connect**.
4. Set the following configuration:
   - **Root Directory**: *(leave blank)*
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Scroll down to **Environment Variables** and click **Add Environment Variable**:
   - `GEMINI_API_KEY` = *(Your official Google Gemini API Key)*
   - `MONGODB_URI` = *(Your MongoDB Atlas Connection string)*
   - `PHONE_NUMBER` = *(The bot's phone number with country code, e.g. 2348012345678)*
6. Click **Deploy Background Service**!
7. Click the **Logs** tab in Render. Watch the terminal output — in a few seconds, copy your hyphenated **Pairing Code** and link it on your WhatsApp app! Once paired, your credentials automatically upload to MongoDB Atlas, locking in 24/7 background uptime!
