type Job = {
  blob: string;
  job_id: string;
  target: string;
  seed_hash: string;
  height?: number;
};

type WorkerMessage = { type: "job"; job: Job } | { type: "stop" };
type Share = { type: "share"; job_id: string; nonce: string; result: string };
type Progress = { type: "progress"; hashes: number };
type Status = { type: "status"; status: string };

let active = true;
let currentJob: Job | null = null;
let randomx: { calculate_hash(input: Uint8Array): Uint8Array } | null = null;
let hashCount = 0;
let throttle = 50;
let seedHex = "";
let miningReported = false;
let jobKey = "";
let input: Uint8Array | null = null;
let nonce: DataView | null = null;
let randomxCreateVm: typeof import("randomx.js").randomx_create_vm;
let randomxInitCache: typeof import("randomx.js").randomx_init_cache;

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function hashMeetsTarget(hash: Uint8Array, target: string): boolean {
  const targetBytes = hexBytes(target);
  if (targetBytes.length === 4) {
    const actual = new DataView(hash.buffer, hash.byteOffset + 28, 4).getUint32(0, true);
    const limit = new DataView(targetBytes.buffer).getUint32(0, true);
    return actual <= limit;
  }
  if (targetBytes.length === 8) {
    let actual = 0n;
    let limit = 0n;
    for (let i = 7; i >= 0; i--) {
      actual = (actual << 8n) | BigInt(hash[24 + i]);
      limit = (limit << 8n) | BigInt(targetBytes[i]);
    }
    return actual <= limit;
  }
  return false;
}

async function init() {
  const workerGlobal = globalThis as typeof globalThis & {
    Buffer?: { from(value: string, encoding: string): Uint8Array };
  };
  workerGlobal.Buffer ??= {
    from(value, encoding) {
      if (encoding !== "base64") throw new Error(`Unsupported encoding: ${encoding}`);
      const bytes = atob(value);
      return Uint8Array.from(bytes, (byte) => byte.charCodeAt(0));
    }
  };
  ({ randomx_create_vm: randomxCreateVm, randomx_init_cache: randomxInitCache } = await import("randomx.js"));
  postMessage({ type: "status", status: "initialising" } satisfies Status);
  await loop();
}

async function loop() {
  let nonceValue = (Math.random() * 0xffffffff) >>> 0;
  let lastReport = performance.now();
  while (active) {
    if (!currentJob) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (currentJob.seed_hash) {
      const seed = hexBytes(currentJob.seed_hash);
      if (currentJob.seed_hash !== seedHex) {
        postMessage({ type: "status", status: "initialising" } satisfies Status);
        try {
          randomx = randomxCreateVm(randomxInitCache(seed));
        } catch (error) {
          postMessage({ type: "status", status: "error", error: `RandomX cache initialisation failed: ${String(error)}` });
          active = false;
          break;
        }
        seedHex = currentJob.seed_hash;
      }
      if (!miningReported) {
        postMessage({ type: "status", status: "mining" } satisfies Status);
        miningReported = true;
      }
    }
    if (currentJob.job_id !== jobKey) {
      const blob = hexBytes(currentJob.blob);
      if (blob.length < 43) {
        postMessage({ type: "status", status: "error", error: "Pool job blob is too short" });
        active = false;
        break;
      }
      input = blob;
      nonce = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      jobKey = currentJob.job_id;
    }
    if (!input || !nonce) {
      postMessage({ type: "status", status: "error", error: "Mining input is not initialised" });
      active = false;
      break;
    }
    const batchStart = performance.now();
    for (let i = 0; i < 32 && active && currentJob; i++) {
      nonce.setUint32(39, nonceValue, true);
      if (!randomx) {
        postMessage({ type: "status", status: "error", error: "RandomX VM is not initialised" });
        active = false;
        break;
      }
      const hash = randomx.calculate_hash(input);
      const result = Array.from(hash, (byte: number) => byte.toString(16).padStart(2, "0")).join("");
      hashCount++;
      if (hashMeetsTarget(hash, currentJob.target)) {
        const nonceHex = Array.from(input.slice(39, 43), (byte) => byte.toString(16).padStart(2, "0")).join("");
        postMessage({ type: "share", job_id: currentJob.job_id, nonce: nonceHex, result } satisfies Share);
      }
      nonceValue = (nonceValue + 1) >>> 0;
    }
    const elapsed = performance.now() - batchStart;
    const now = performance.now();
    if (now - lastReport > 500) {
      postMessage({ type: "progress", hashes: hashCount } satisfies Progress);
      hashCount = 0;
      lastReport = now;
    }
    if (throttle < 100) {
      const pause = elapsed * ((100 - throttle) / throttle);
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerMessage | { type: "throttle"; value: number }>) => {
  if (event.data.type === "job") {
    currentJob = event.data.job;
    miningReported = false;
  } else if (event.data.type === "throttle") {
    throttle = Math.max(10, Math.min(100, event.data.value));
  } else if (event.data.type === "stop") {
    active = false;
  }
};

init().catch((error) => postMessage({ type: "status", status: "error", error: String(error) }));
