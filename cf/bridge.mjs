import { targetToDifficulty } from "./auth.mjs";

const walletPattern = /^[48][0-9A-Za-z]{94}$/;

export function isValidWallet(wallet) {
  return typeof wallet === "string" && walletPattern.test(wallet);
}

function validHex(value, length) {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/i.test(value);
}

export function createBridge({
  wallet,
  poolFixedDiff = "",
  sendToClient,
  writeToPool,
  closePool,
  onShareAccepted = () => {}
}) {
  let buffer = "";
  let requestId = 1;
  let closed = false;
  let loginComplete = false;
  let poolSessionId;
  const currentJobs = new Map();
  const requests = new Map();
  const submissions = [];

  const close = () => {
    if (closed) return;
    closed = true;
    closePool();
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
    sendToClient({ type: "job", job: normalized });
  };

  const onPoolConnect = () => {
    const id = requestId++;
    requests.set(id, { type: "login" });
    writeToPool(
      `${JSON.stringify({
        id,
        jsonrpc: "2.0",
        method: "login",
        params: {
          login: poolFixedDiff ? `${wallet}+${poolFixedDiff}` : wallet,
          pass: "x",
          agent: "mine-site/0.1",
          rigid: ""
        }
      })}\n`
    );
  };

  const onPoolData = (text) => {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        sendToClient({ type: "error", error: "Invalid response from pool" });
        continue;
      }

      if (message.method === "job") {
        emitJob(message.params);
        continue;
      }
      if (message.method === "client.reconnect") {
        sendToClient({ type: "error", error: "Pool requested reconnect" });
        close();
        return;
      }
      if (message.id === undefined) continue;
      const request = requests.get(message.id);
      requests.delete(message.id);
      if (request?.type === "login") {
        if (message.error || !message.result) {
          sendToClient({ type: "error", error: message.error?.message || "Pool login failed" });
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
          sendToClient({
            type: "rejected",
            error: message.error?.message || message.result?.status || "Share rejected"
          });
        } else {
          const difficulty = targetToDifficulty(currentJobs.get(request.jobId)?.target || "");
          sendToClient({ type: "accepted", difficulty });
          onShareAccepted(difficulty);
        }
      }
    }
  };

  const onPoolClose = () => {
    loginComplete = false;
    if (!closed) sendToClient({ type: "error", error: "Pool connection closed" });
  };

  const onPoolError = (error) => {
    if (!closed) sendToClient({ type: "error", error: error.message });
  };

  const submit = ({ job_id: jobId, nonce, result }) => {
    if (!loginComplete) return sendToClient({ type: "error", error: "Pool is not ready" });
    if (
      typeof jobId !== "string" ||
      jobId.length === 0 ||
      jobId.length > 256 ||
      !validHex(nonce, 8) ||
      !validHex(result, 64)
    ) {
      return sendToClient({ type: "error", error: "Invalid share format" });
    }
    if (!currentJobs.has(jobId)) return sendToClient({ type: "rejected", error: "Unknown job" });
    const now = Date.now();
    while (submissions.length && submissions[0] <= now - 60_000) submissions.shift();
    if (submissions.length >= 20) return sendToClient({ type: "error", error: "Submit rate limit exceeded" });
    submissions.push(now);
    const id = requestId++;
    requests.set(id, { type: "submit", jobId });
    writeToPool(
      `${JSON.stringify({
        id,
        jsonrpc: "2.0",
        method: "submit",
        params: { id: poolSessionId, job_id: jobId, nonce, result }
      })}\n`
    );
  };

  const onClientMessage = (text) => {
    try {
      const message = JSON.parse(typeof text === "string" ? text : String(text));
      if (message?.type === "submit") submit(message);
    } catch {
      sendToClient({ type: "error", error: "Invalid client message" });
    }
  };

  return { onPoolConnect, onPoolData, onPoolClose, onPoolError, onClientMessage, close };
}
