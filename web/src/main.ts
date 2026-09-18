import "./style.css";

type Config = { miningEnabled: boolean };
type User = { id: number; username: string };
type Job = { blob: string; job_id: string; target: string; seed_hash: string; height?: number };
type JobMessage = { type: "job"; job: Job };
type LeaderboardEntry = { rank: number; username: string; verified_hashes: number; shares: number };

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header>
    <div><div class="brand">Mine Site</div><span class="tagline">A small site with a transparent CPU option</span></div>
    <div class="account-panel">
      <button id="account-toggle" class="account-toggle" type="button">Sign in / Create account</button>
      <div id="account-form" class="account-form" hidden>
        <input id="account-username" autocomplete="username" placeholder="Username" maxlength="20" />
        <input id="account-password" type="password" autocomplete="current-password" placeholder="Password" />
        <div><button id="sign-in" type="button">Sign in</button><button id="create-account" type="button">Create account</button></div>
        <p id="account-notice" class="form-notice"></p>
      </div>
      <div id="account-signed-in" hidden></div>
    </div>
  </header>
  <main>
    <section class="welcome"><p class="eyebrow">Welcome</p><h1>Site content goes here</h1><p class="muted">Coming soon. In the meantime, you can optionally support hosting costs with your CPU.</p></section>
    <section class="miner-card">
      <div class="card-heading"><div><p class="eyebrow">Optional support</p><h2>Support this site with your CPU</h2></div><span id="status" class="status stopped">stopped</span></div>
      <p id="attribution" class="attribution">Sign in to appear on the leaderboard</p>
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
        <div><span>Verified shares</span><strong id="accepted">0</strong></div>
        <div><span>Rejected shares</span><strong id="rejected">0</strong></div>
      </div>
      <p class="footnote">Hashrate is local browser work. The leaderboard counts only pool-verified shares multiplied by their accepted difficulty. RandomX uses about 256 MB of RAM per mining thread and may take a few seconds to initialise.</p>
    </section>
    <section class="leaderboard-card">
      <div class="card-heading"><div><p class="eyebrow">Community</p><h2>Leaderboard</h2></div></div>
      <div id="leaderboard"><p class="muted">Loading leaderboard…</p></div>
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
const accountToggle = document.querySelector<HTMLButtonElement>("#account-toggle")!;
const accountForm = document.querySelector<HTMLDivElement>("#account-form")!;
const accountUsername = document.querySelector<HTMLInputElement>("#account-username")!;
const accountPassword = document.querySelector<HTMLInputElement>("#account-password")!;
const accountNotice = document.querySelector<HTMLParagraphElement>("#account-notice")!;
const accountSignedIn = document.querySelector<HTMLDivElement>("#account-signed-in")!;
const attribution = document.querySelector<HTMLParagraphElement>("#attribution")!;
const leaderboard = document.querySelector<HTMLDivElement>("#leaderboard")!;

let currentUser: User | null = null;
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
  while (hashWindow.length && hashWindow[0].at < cutoff) hashWindowTotal -= hashWindow.shift()!.count;
  updateStats();
}
function updateAttribution() {
  attribution.textContent = currentUser
    ? `Mining as ${currentUser.username} — your verified work counts on the leaderboard`
    : "Sign in to appear on the leaderboard";
}
function formatHashes(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return value.toLocaleString();
}
async function refreshLeaderboard() {
  try {
    const response = await fetch("/api/leaderboard");
    const data = await response.json() as { leaderboard?: LeaderboardEntry[] };
    const rows = data.leaderboard || [];
    leaderboard.innerHTML = rows.length
      ? `<table><thead><tr><th>Rank</th><th>Username</th><th>Verified hashes</th><th>Shares</th></tr></thead><tbody>${rows.map((row) =>
        `<tr><td>${row.rank}</td><td>${row.username}</td><td>${formatHashes(row.verified_hashes)}</td><td>${row.shares.toLocaleString()}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">No verified shares yet.</p>`;
  } catch {
    leaderboard.innerHTML = `<p class="muted">Leaderboard unavailable.</p>`;
  }
}
async function refreshAccount() {
  const data = await fetch("/api/me").then((response) => response.json() as Promise<{ user: User | null }>);
  currentUser = data.user;
  accountToggle.hidden = Boolean(currentUser);
  accountForm.hidden = true;
  accountSignedIn.hidden = !currentUser;
  if (currentUser) {
    accountSignedIn.innerHTML = `Signed in as <strong>${currentUser.username}</strong> · <button id="sign-out" type="button">Sign out</button>`;
    document.querySelector<HTMLButtonElement>("#sign-out")!.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      await refreshAccount();
      await refreshLeaderboard();
    });
  } else {
    accountSignedIn.textContent = "";
  }
  updateAttribution();
}
async function accountAction(path: string) {
  accountNotice.textContent = "";
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: accountUsername.value, password: accountPassword.value })
  });
  const data = await response.json() as { error?: string };
  if (!response.ok) {
    accountNotice.textContent = data.error || "Account request failed";
    return;
  }
  accountPassword.value = "";
  await refreshAccount();
  await refreshLeaderboard();
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
    workers = Array.from({ length: Number(threadsSelect.value) }, createWorker);
  };
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data) as JobMessage | { type: string; error?: string };
    if (message.type === "job") {
      lastJob = (message as JobMessage).job;
      workers.forEach((worker) => worker.postMessage(message));
    } else if (message.type === "accepted") {
      accepted++;
      updateStats();
      void refreshLeaderboard();
    } else if (message.type === "rejected") {
      rejected++;
      updateStats();
    } else if (message.type === "error") {
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

accountToggle.addEventListener("click", () => { accountForm.hidden = !accountForm.hidden; });
document.querySelector<HTMLButtonElement>("#sign-in")!.addEventListener("click", () => void accountAction("/api/login"));
document.querySelector<HTMLButtonElement>("#create-account")!.addEventListener("click", () => void accountAction("/api/register"));
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
setInterval(() => void refreshLeaderboard(), 30_000);
updateStats();
void refreshAccount();
void refreshLeaderboard();
void fetch("/api/config").then((response) => response.json() as Promise<Config>).then((config) => {
  if (!config.miningEnabled) showNotice("Mining not configured");
});
