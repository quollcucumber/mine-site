import "./style.css";

type Config = { miningEnabled: boolean };
type Job = { blob: string; job_id: string; target: string; seed_hash: string; height?: number };
type JobMessage = { type: "job"; job: Job };

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header><div class="brand">Mine Site</div><span class="tagline">A small site with a transparent CPU option</span></header>
  <main>
    <section class="welcome"><p class="eyebrow">Welcome</p><h1>Site content goes here</h1><p class="muted">Coming soon. In the meantime, you can optionally support hosting costs with your CPU.</p></section>
    <section class="miner-card">
      <div class="card-heading"><div><p class="eyebrow">Optional support</p><h2>Support this site with your CPU</h2></div><span id="status" class="status stopped">stopped</span></div>
      <p class="explanation">When enabled, this tab mines Monero for the site owner using your CPU. Mining never starts automatically, runs only while this tab is open and the toggle is on, and stopping it releases the workers.</p>
      <div id="notice" class="notice" hidden></div>
      <div class="controls">
        <button id="toggle" class="toggle" type="button">Start mining</button>
        <label>Threads <select id="threads"></select></label>
        <label class="slider-label">CPU use <input id="throttle" type="range" min="10" max="100" value="50" /> <output id="throttle-value">50%</output></label>
      </div>
      <div class="stats">
        <div><span>Hashrate</span><strong id="hashrate">0 H/s</strong></div>
        <div><span>Total hashes</span><strong id="hashes">0</strong></div>
        <div><span>Accepted shares</span><strong id="accepted">0</strong></div>
        <div><span>Rejected shares</span><strong id="rejected">0</strong></div>
      </div>
      <p class="footnote">RandomX uses about 256 MB of RAM per mining thread and may take a few seconds to initialise.</p>
    </section>
  </main>
  <footer>Mining is opt-in. You are always in control.</footer>
`;

const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
const threadsSelect = document.querySelector<HTMLSelectElement>("#threads")!;
const throttleInput = document.querySelector<HTMLInputElement>("#throttle")!;
const throttleValue = document.querySelector<HTMLOutputElement>("#throttle-value")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const notice = document.querySelector<HTMLDivElement>("#notice")!;
const hashrate = document.querySelector<HTMLElement>("#hashrate")!;
const hashesOutput = document.querySelector<HTMLElement>("#hashes")!;
const acceptedOutput = document.querySelector<HTMLElement>("#accepted")!;
const rejectedOutput = document.querySelector<HTMLElement>("#rejected")!;

const maxThreads = Math.max(1, Math.min(navigator.hardwareConcurrency || 1, 4));
for (let i = 1; i <= maxThreads; i++) threadsSelect.add(new Option(String(i), String(i)));
threadsSelect.value = "1";
let workers: Worker[] = [];
let socket: WebSocket | null = null;
let totalHashes = 0;
let accepted = 0;
let rejected = 0;
let lastJob: Job | null = null;
let hashWindow: Array<{ at: number; count: number }> = [];
let hashWindowTotal = 0;
let running = false;

function setStatus(value: string, className = value) {
  status.textContent = value;
  status.className = `status ${className}`;
}
function showNotice(value: string) {
  notice.hidden = !value;
  notice.textContent = value;
}
function updateStats() {
  hashesOutput.textContent = totalHashes.toLocaleString();
  acceptedOutput.textContent = String(accepted);
  rejectedOutput.textContent = String(rejected);
  hashrate.textContent = `${Math.round(hashWindowTotal / 5).toLocaleString()} H/s`;
}

function refreshHashrate() {
  const cutoff = performance.now() - 5000;
  while (hashWindow.length && hashWindow[0].at < cutoff) {
    hashWindowTotal -= hashWindow.shift()!.count;
  }
  updateStats();
}

function createWorker() {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.postMessage({ type: "throttle", value: Number(throttleInput.value) });
  if (lastJob) worker.postMessage({ type: "job", job: lastJob });
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      const now = performance.now();
      totalHashes += data.hashes;
      hashWindow.push({ at: now, count: data.hashes });
      hashWindowTotal += data.hashes;
      updateStats();
    } else if (data.type === "share") {
      socket?.send(JSON.stringify({ type: "submit", ...data }));
    } else if (data.type === "status" && data.status === "mining") {
      setStatus("mining", "mining");
    } else if (data.type === "status" && data.status === "error") {
      setStatus("error", "error");
      showNotice(data.error || "Worker error");
    }
  };
  return worker;
}

async function startMining() {
  if (running) return;
  const config = await fetch("/api/config").then((response) => response.json() as Promise<Config>);
  if (!config.miningEnabled) {
    showNotice("Mining not configured");
    setStatus("error", "error");
    return;
  }
  lastJob = null;
  hashWindow = [];
  hashWindowTotal = 0;
  running = true;
  toggle.textContent = "Stop mining";
  toggle.classList.add("active");
  showNotice("");
  setStatus("connecting", "connecting");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.onopen = () => {
    setStatus("initialising RandomX cache", "initialising");
    const count = Number(threadsSelect.value);
    workers = Array.from({ length: count }, createWorker);
  };
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data) as JobMessage | { type: string; error?: string };
    if (message.type === "job") {
      lastJob = (message as JobMessage).job;
      workers.forEach((worker) => worker.postMessage(message));
    }
    if (message.type === "accepted") {
      accepted++;
      updateStats();
    }
    if (message.type === "rejected") {
      rejected++;
      updateStats();
    }
    if (message.type === "error") {
      setStatus("error", "error");
      showNotice(message.error || "Pool error");
    }
  };
  socket.onerror = () => {
    setStatus("error", "error");
    showNotice("Unable to connect to the mining pool");
  };
  socket.onclose = () => {
    if (running) {
      setStatus("error", "error");
      showNotice("Connection to pool closed");
    }
  };
}

function stopMining() {
  running = false;
  workers.forEach((worker) => {
    worker.postMessage({ type: "stop" });
    worker.terminate();
  });
  workers = [];
  socket?.close();
  socket = null;
  toggle.textContent = "Start mining";
  toggle.classList.remove("active");
  setStatus("stopped", "stopped");
  lastJob = null;
  hashWindow = [];
  hashWindowTotal = 0;
  updateStats();
}

toggle.addEventListener("click", () => (running ? stopMining() : void startMining()));
throttleInput.addEventListener("input", () => {
  throttleValue.value = `${throttleInput.value}%`;
  workers.forEach((worker) => worker.postMessage({ type: "throttle", value: Number(throttleInput.value) }));
});
threadsSelect.addEventListener("change", () => {
  if (running) {
    workers.forEach((worker) => {
      worker.postMessage({ type: "stop" });
      worker.terminate();
    });
    workers = Array.from({ length: Number(threadsSelect.value) }, createWorker);
  }
});
setInterval(refreshHashrate, 1000);
updateStats();
void fetch("/api/config").then((response) => response.json() as Promise<Config>).then((config) => {
  if (!config.miningEnabled) showNotice("Mining not configured");
});
