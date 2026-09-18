import express from "express";
import { createServer } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "web", "dist");
const port = Number(process.env.PORT || 8080);
const poolHost = process.env.POOL_HOST || "pool.supportxmr.com";
const poolPort = Number(process.env.POOL_PORT || 3333);
const walletCandidate = process.env.XMR_WALLET || "";
const walletPattern = /^[48][0-9A-Za-z]{94}$/;
const wallet = walletPattern.test(walletCandidate) ? walletCandidate : "";
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

function validHex(value, length) {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/i.test(value);
}

function createPoolBridge(ws) {
  if (!wallet) {
    send(ws, { type: "error", error: "Mining not configured" });
    return () => {};
  }

  const socket = net.createConnection({ host: poolHost, port: poolPort });
  let buffer = "";
  let requestId = 1;
  let closed = false;
  let currentJobs = new Map();
  let loginComplete = false;
  let poolSessionId;
  const requests = new Map();
  const submissions = [];

  const close = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    currentJobs.clear();
    requests.clear();
  };

  const emitJob = (job) => {
    if (!job || typeof job !== "object") return;
    const normalized = {
      blob: job.blob,
      job_id: job.job_id,
      target: job.target,
      seed_hash: job.seed_hash || "",
      height: job.height
    };
    if (
      typeof normalized.blob !== "string" ||
      typeof normalized.job_id !== "string" ||
      typeof normalized.target !== "string"
    ) return;
    currentJobs.set(normalized.job_id, normalized);
    if (currentJobs.size > 32) currentJobs.delete(currentJobs.keys().next().value);
    send(ws, { type: "job", job: normalized });
  };

  const sendLogin = () => {
    const id = requestId++;
    requests.set(id, { type: "login" });
    socket.write(
      `${JSON.stringify({
        id,
        jsonrpc: "2.0",
        method: "login",
        params: { login: wallet, pass: "x", agent: "mine-site/0.1", rigid: "" }
      })}\n`
    );
  };

  socket.setEncoding("utf8");
  socket.on("connect", sendLogin);
  socket.on("data", (data) => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send(ws, { type: "error", error: "Invalid response from pool" });
        continue;
      }

      if (message.method === "job") {
        emitJob(message.params);
        continue;
      }
      if (message.method === "client.reconnect") {
        send(ws, { type: "error", error: "Pool requested reconnect" });
        close();
        return;
      }
      if (message.id === undefined) continue;
      const request = requests.get(message.id);
      requests.delete(message.id);
      if (request?.type === "login") {
        if (message.error || !message.result) {
          send(ws, { type: "error", error: message.error?.message || "Pool login failed" });
          close();
          return;
        }
        loginComplete = true;
        poolSessionId = message.result.id;
        emitJob(message.result.job);
        continue;
      }
      if (request?.type === "submit") {
        if (message.error || message.result?.status !== "OK") {
          send(ws, { type: "rejected", error: message.error?.message || message.result?.status || "Share rejected" });
        } else {
          send(ws, { type: "accepted" });
        }
      }
    }
  });
  socket.on("error", (error) => send(ws, { type: "error", error: error.message }));
  socket.on("close", () => {
    loginComplete = false;
    if (!closed) send(ws, { type: "error", error: "Pool connection closed" });
  });

  const submit = ({ job_id: jobId, nonce, result }) => {
    if (!loginComplete) return send(ws, { type: "error", error: "Pool is not ready" });
    if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 256 || !validHex(nonce, 8) || !validHex(result, 64)) {
      return send(ws, { type: "error", error: "Invalid share format" });
    }
    const job = currentJobs.get(jobId);
    if (!job) return send(ws, { type: "rejected", error: "Unknown job" });
    const now = Date.now();
    while (submissions.length && submissions[0] <= now - 60_000) submissions.shift();
    if (submissions.length >= 20) return send(ws, { type: "error", error: "Submit rate limit exceeded" });
    submissions.push(now);
    const id = requestId++;
    requests.set(id, { type: "submit" });
    socket.write(
      `${JSON.stringify({
        id,
        jsonrpc: "2.0",
        method: "submit",
        params: { id: poolSessionId, job_id: jobId, nonce, result }
      })}\n`
    );
  };

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message?.type === "submit") submit(message);
    } catch {
      send(ws, { type: "error", error: "Invalid client message" });
    }
  });
  ws.on("close", close);
  return close;
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
