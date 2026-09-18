import express from "express";
import { createServer } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createBridge, isValidWallet } from "./bridge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "web", "dist");
const port = Number(process.env.PORT || 8080);
const poolHost = process.env.POOL_HOST || "pool.supportxmr.com";
const poolPort = Number(process.env.POOL_PORT || 3333);
const walletCandidate = process.env.XMR_WALLET || "";
const wallet = isValidWallet(walletCandidate) ? walletCandidate : "";
if (walletCandidate && !wallet) {
  console.warn("XMR_WALLET is invalid; mining is disabled");
}

const app = express();
app.get("/api/config", (_req, res) => {
  res.json({ miningEnabled: Boolean(wallet) });
});
app.use(express.static(publicDir));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const httpServer = createServer(app);
const websocketServer = new WebSocketServer({ noServer: true });

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function createPoolBridge(ws) {
  if (!wallet) {
    send(ws, { type: "error", error: "Mining not configured" });
    return () => {};
  }

  const socket = net.createConnection({ host: poolHost, port: poolPort });
  const bridge = createBridge({
    wallet,
    sendToClient: (message) => send(ws, message),
    writeToPool: (text) => socket.write(text),
    closePool: () => socket.destroy()
  });
  socket.setEncoding("utf8");
  socket.on("connect", bridge.onPoolConnect);
  socket.on("data", bridge.onPoolData);
  socket.on("error", bridge.onPoolError);
  socket.on("close", bridge.onPoolClose);
  ws.on("message", (raw) => bridge.onClientMessage(raw.toString()));
  ws.on("close", bridge.close);
  return bridge.close;
}

httpServer.on("upgrade", (request, socket, head) => {
  if (new URL(request.url, "http://localhost").pathname !== "/ws") {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (ws) => {
    websocketServer.emit("connection", ws, request);
  });
});
websocketServer.on("connection", (ws) => createPoolBridge(ws));

httpServer.listen(port, () => {
  console.log(`mine-site listening on http://localhost:${port}`);
  if (!wallet) console.warn("XMR_WALLET is not configured; mining is disabled");
});
