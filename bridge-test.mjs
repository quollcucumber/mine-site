import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import WebSocket from "ws";

const wallet = `4${"A".repeat(94)}`;
const job = {
  blob: "00".repeat(76),
  job_id: "a1b2",
  target: "b2df0000",
  seed_hash: "11".repeat(32),
  height: 1
};

let submitParams;
let poolSocket;
let poolBuffer = "";
const poolServer = net.createServer((connection) => {
  poolSocket = connection;
  connection.setEncoding("utf8");
  connection.on("data", (data) => {
    poolBuffer += data;
    let newline;
    while ((newline = poolBuffer.indexOf("\n")) !== -1) {
      const line = poolBuffer.slice(0, newline).trim();
      poolBuffer = poolBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "login") {
        connection.write(
          `${JSON.stringify({
            id: message.id,
            jsonrpc: "2.0",
            result: { id: "abc", job, status: "OK" }
          })}\n`
        );
      } else if (message.method === "submit") {
        submitParams = message.params;
        connection.write(`${JSON.stringify({ id: message.id, jsonrpc: "2.0", result: { status: "OK" } })}\n`);
      }
    }
  });
});

await new Promise((resolve) => poolServer.listen(0, "127.0.0.1", resolve));
const poolPort = poolServer.address().port;
const server = spawn(process.execPath, ["server/index.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: {
    ...process.env,
    PORT: "18080",
    POOL_HOST: "127.0.0.1",
    POOL_PORT: String(poolPort),
    XMR_WALLET: wallet
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
server.stdout.on("data", (data) => {
  output += data;
});
server.stderr.on("data", (data) => {
  output += data;
});

const waitForServer = new Promise((resolve, reject) => {
  const deadline = Date.now() + 10_000;
  const check = () => {
    if (Date.now() > deadline) return reject(new Error(`Bridge server did not start:\n${output}`));
    const client = new WebSocket("ws://127.0.0.1:18080/ws");
    const timeout = setTimeout(() => {
      client.close();
      setTimeout(check, 100);
    }, 500);
    client.on("open", () => {
      clearTimeout(timeout);
      resolve(client);
    });
    client.on("error", () => {
      clearTimeout(timeout);
      client.close();
      setTimeout(check, 100);
    });
  };
  check();
});

let client;
try {
  client = await waitForServer;
  const receivedJob = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Fake pool job was not forwarded")), 5000);
    client.on("message", (data) => {
      const message = JSON.parse(data);
      if (message.type === "job") {
        clearTimeout(timeout);
        resolve(message.job);
      }
    });
    client.on("error", reject);
  });
  assert.deepEqual(receivedJob, job);
  client.send(JSON.stringify({ type: "submit", job_id: job.job_id, nonce: "01020304", result: "00".repeat(32) }));
  const deadline = Date.now() + 5000;
  while (!submitParams && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(submitParams, {
    id: "abc",
    job_id: job.job_id,
    nonce: "01020304",
    result: "00".repeat(32)
  });
  console.log("Stratum bridge test passed: session id and share params forwarded");
} finally {
  client?.close();
  poolSocket?.destroy();
  poolServer.close();
  server.kill();
}
