import assert from "node:assert/strict";
import { createBridge } from "./cf/bridge.mjs";

const wallet = `4${"A".repeat(94)}`;
const job = {
  blob: "00".repeat(76),
  job_id: "pool-job-a1b2",
  target: "b2df0000",
  seed_hash: "11".repeat(32),
  height: 1
};
const clientMessages = [];
const poolMessages = [];
let closeCount = 0;
let acceptedDifficulty = 0;

const bridge = createBridge({
  wallet,
  poolFixedDiff: "5000",
  sendToClient: (message) => clientMessages.push(message),
  writeToPool: (text) => poolMessages.push(JSON.parse(text)),
  closePool: () => closeCount++,
  onShareAccepted: (difficulty) => {
    acceptedDifficulty = difficulty;
  }
});

bridge.onPoolConnect();
assert.equal(poolMessages[0].method, "login");
assert.equal(poolMessages[0].params.login, `${wallet}+5000`);

bridge.onPoolData(`${JSON.stringify({
  id: poolMessages[0].id,
  jsonrpc: "2.0",
  result: { id: "abc", job, status: "OK" }
})}\n`);
assert.deepEqual(clientMessages[0], { type: "job", job });

bridge.onClientMessage(JSON.stringify({
  type: "submit",
  job_id: job.job_id,
  nonce: "01020304",
  result: "00".repeat(32)
}));
const submit = poolMessages[1];
assert.deepEqual(submit.params, {
  id: "abc",
  job_id: job.job_id,
  nonce: "01020304",
  result: "00".repeat(32)
});

bridge.onPoolData(`${JSON.stringify({
  id: submit.id,
  jsonrpc: "2.0",
  result: { status: "OK" }
})}\n`);
assert.equal(acceptedDifficulty, 75000);
assert.deepEqual(clientMessages.at(-1), { type: "accepted", difficulty: 75000 });
bridge.close();
bridge.close();
assert.equal(closeCount, 1);
console.log("Stratum bridge test passed: fixed difficulty, session id, and share difficulty");
