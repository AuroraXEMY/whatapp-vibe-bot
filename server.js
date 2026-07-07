/**
 * Keep-Alive Web Server for Render
 * 
 * SOLE PURPOSE: Keeps your Render container awake 24/7 on the Free Tier
 * by listening on the assigned port and accepting self-pings or external pings.
 */

const http = require("http");
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  if (req.url === "/ping" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("PONG - VibeGuard Keep-Alive is Active! 🌴😎");
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 [KEEP-ALIVE] Server listening on port ${PORT}! Ready to handle Render Web Service checks.`);
});

// --- Optional Internal Self-Ping loop to prevent Free Tier from sleeping ---
// (Pings itself every 10 minutes)
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  console.log(`⏱️ [KEEP-ALIVE] Auto self-ping loop active. Target: ${SELF_URL}`);
  setInterval(() => {
    http.get(SELF_URL, (res) => {
      console.log(`💓 [KEEP-ALIVE] Self-ping successful: Status ${res.statusCode}`);
    }).on("error", (err) => {
      console.error("⚠️ [KEEP-ALIVE] Self-ping failed:", err.message);
    });
  }, 10 * 60 * 1000); // 10 minutes
}