import "./style.css";

type Config = { miningEnabled: boolean };
type User = { id: number; username: string };
type Job = { blob: string; job_id: string; target: string; seed_hash: string; height?: number };
type JobMessage = { type: "job"; job: Job };
type LeaderboardEntry = { rank: number; username: string; verified_hashes: number; reported_hashes: number; shares: number; group_name: string | null };
type Group = { id: number; name: string; is_open: boolean; member_count?: number };
type GroupMember = { user_id: number; username: string; role: "owner" | "admin" | "member"; verified_hashes: number; reported_hashes: number };
type Standing = { points: number; rank: number | null; player_count: number; group: { id: number; name: string; rank: number } | null };

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header>
    <div><div class="brand">Mine Site</div><span class="tagline">Browser mining leaderboard</span></div>
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
    <section class="hero">
      <div class="hero-copy"><p class="eyebrow">Competition starts here</p><h1>Mine. Score. Climb the ranks.</h1><p class="hero-sub">Turn spare CPU into points, solo or with your group. Every pool-verified share is worth 200 points.</p><div class="hero-actions"><button id="hero-start" class="toggle" type="button">Start mining</button><button id="hero-account" class="secondary-button" type="button">Create an account</button></div></div>
      <div class="steps"><div><strong>01</strong><span>Create an account</span><small>Track your standing and scores.</small></div><div><strong>02</strong><span>Start mining</span><small>Choose your threads and CPU use.</small></div><div><strong>03</strong><span>Form a group</span><small>Invite friends and add your points.</small></div></div>
    </section>
    <section id="standing" class="standing-card"></section>
    <section class="leaderboard-card">
      <div class="card-heading"><div><p class="eyebrow">Community</p><h2>Leaderboard</h2></div></div>
      <div class="tabs"><button id="players-tab" class="tab active" type="button">Players</button><button id="groups-tab" class="tab" type="button">Groups</button></div>
      <div id="leaderboard"><p class="muted">Loading leaderboard…</p></div>
      <p class="leaderboard-note">1 point = 100 pool-verified hashes (one accepted share = 200 points). Reported hashes are unverified and only break ties.</p>
    </section>
    <section id="groups-section" class="leaderboard-card">
      <div class="card-heading"><div><p class="eyebrow">Competition</p><h2>Groups</h2></div></div>
      <div id="group-notice" class="notice" hidden></div>
      <div id="groups-content"></div>
    </section>
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
const standing = document.querySelector<HTMLElement>("#standing")!;
const heroStart = document.querySelector<HTMLButtonElement>("#hero-start")!;
const heroAccount = document.querySelector<HTMLButtonElement>("#hero-account")!;
const leaderboard = document.querySelector<HTMLDivElement>("#leaderboard")!;
const playersTab = document.querySelector<HTMLButtonElement>("#players-tab")!;
const groupsTab = document.querySelector<HTMLButtonElement>("#groups-tab")!;
const groupsContent = document.querySelector<HTMLDivElement>("#groups-content")!;
const groupNotice = document.querySelector<HTMLDivElement>("#group-notice")!;

let currentUser: User | null = null;
let currentStanding: Standing | null = null;
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
let progressSinceReport = 0;
let leaderboardTab: "players" | "groups" = "players";

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
function formatPoints(verifiedHashes: number) {
  return Math.floor(verifiedHashes / 100).toLocaleString();
}
function renderStanding() {
  if (!currentUser || !currentStanding) {
    standing.innerHTML = `<p class="muted">Sign in to track your rank</p>`;
    return;
  }
  const group = currentStanding.group
    ? `${escapeHtml(currentStanding.group.name)} · #${currentStanding.group.rank} group`
    : "No group — create or join one";
  standing.innerHTML = `<div><p class="eyebrow">Your standing</p><h2>${escapeHtml(currentUser.username)}</h2></div><div class="standing-stat"><span>Points</span><strong>${currentStanding.points.toLocaleString()}</strong></div><div class="standing-stat"><span>Player rank</span><strong>#${currentStanding.rank ?? "—"} <small>of ${currentStanding.player_count}</small></strong></div><div class="standing-group"><span>Group</span><strong>${group}</strong></div>`;
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]!));
}
function showGroupNotice(value: string) {
  groupNotice.hidden = !value;
  groupNotice.textContent = value;
}
async function groupRequest(path: string, options: RequestInit = {}) {
  const response = await fetch(path, options);
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error || "Group request failed");
  return data;
}
async function refreshLeaderboard() {
  try {
    if (leaderboardTab === "players") {
      const data = await fetch("/api/leaderboard").then((response) => response.json() as Promise<{ leaderboard?: LeaderboardEntry[] }>);
      const rows = data.leaderboard || [];
      leaderboard.innerHTML = rows.length
        ? `<table><thead><tr><th>Rank</th><th>Username</th><th>Group</th><th>Points</th><th class="reported-column">Reported hashes (unverified)</th><th>Shares</th></tr></thead><tbody>${rows.map((row) =>
          `<tr><td>${row.rank}</td><td>${escapeHtml(row.username)}</td><td>${row.group_name ? escapeHtml(row.group_name) : "—"}</td><td>${formatPoints(row.verified_hashes)}</td><td class="reported-column">${formatHashes(row.reported_hashes)}</td><td>${row.shares.toLocaleString()}</td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">No leaderboard activity yet.</p>`;
    } else {
      const data = await fetch("/api/leaderboard/groups").then((response) => response.json() as Promise<{ leaderboard?: Array<{ name: string; member_count: number; verified_hashes: number; reported_hashes: number }> }>);
      const rows = data.leaderboard || [];
      leaderboard.innerHTML = rows.length
        ? `<table><thead><tr><th>Rank</th><th>Group</th><th>Members</th><th>Points</th><th class="reported-column">Reported hashes (unverified)</th></tr></thead><tbody>${rows.map((row, index) =>
          `<tr><td>${index + 1}</td><td>${escapeHtml(row.name)}</td><td>${row.member_count}</td><td>${formatPoints(row.verified_hashes)}</td><td class="reported-column">${formatHashes(row.reported_hashes)}</td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">No groups yet.</p>`;
    }
  } catch {
    leaderboard.innerHTML = `<p class="muted">Leaderboard unavailable.</p>`;
  }
}
async function refreshGroups() {
  if (!currentUser) {
    groupsContent.innerHTML = `<p class="muted">Sign in to join a group.</p>`;
    return;
  }
  try {
    const [mine, invites, openGroups] = await Promise.all([
      groupRequest("/api/groups/mine") as Promise<{ group: Group | null; members: GroupMember[]; my_role: string | null }>,
      groupRequest("/api/invites") as Promise<{ invites: Array<{ id: number; name: string; inviter: string }> }>,
      groupRequest("/api/groups") as Promise<{ groups: Group[] }>
    ]);
    const inviteHtml = invites.invites.length
      ? `<div class="invites"><h3>Pending invites</h3>${invites.invites.map((invite) =>
          `<div class="invite-row"><span>${escapeHtml(invite.name)} <small>from ${escapeHtml(invite.inviter)}</small></span><span><button data-invite-action="accept" data-invite-id="${invite.id}" type="button">Accept</button><button data-invite-action="decline" data-invite-id="${invite.id}" type="button">Decline</button></span></div>`).join("")}</div>`
      : "";
    if (!mine.group) {
      groupsContent.innerHTML = `${inviteHtml}<div class="group-create"><h3>Create a group</h3><div class="inline-form"><input id="new-group-name" placeholder="Group name" maxlength="24" /><label><input id="new-group-open" type="checkbox" checked /> Open group</label><button data-group-action="create" type="button">Create</button></div></div><h3>Open groups</h3>${openGroups.groups.length ? `<div class="open-groups">${openGroups.groups.map((group) => `<div class="group-row"><span>${escapeHtml(group.name)} <small>${group.member_count} members</small></span><button data-group-action="join" data-group-id="${group.id}" type="button">Join</button></div>`).join("")}</div>` : `<p class="muted">No open groups yet.</p>`}`;
    } else {
      const owner = mine.my_role === "owner";
      const manager = owner || mine.my_role === "admin";
      groupsContent.innerHTML = `${inviteHtml}<div class="group-card"><div class="group-card-heading"><h3>${escapeHtml(mine.group.name)}</h3><span class="badge">${mine.group.is_open ? "Open" : "Invite-only"}</span></div>${owner ? `<div class="inline-form"><input id="rename-group" value="${escapeHtml(mine.group.name)}" maxlength="24" /><label><input id="group-open" type="checkbox" ${mine.group.is_open ? "checked" : ""} /> Open group</label><button data-group-action="update" type="button">Save</button></div>` : ""}<table><thead><tr><th>Username</th><th>Role</th><th>Points</th><th class="reported-column">Reported</th><th></th></tr></thead><tbody>${mine.members.map((member) => {
        const actions = owner && member.user_id !== currentUser!.id
          ? `<button data-member-action="role" data-role="${member.role === "admin" ? "member" : "admin"}" data-member-id="${member.user_id}" type="button">${member.role === "admin" ? "Demote" : "Promote"}</button><button data-member-action="transfer" data-member-id="${member.user_id}" type="button">Transfer</button><button data-member-action="kick" data-member-id="${member.user_id}" type="button">Kick</button>`
          : mine.my_role === "admin" && member.role === "member"
            ? `<button data-member-action="kick" data-member-id="${member.user_id}" type="button">Kick</button>`
            : "";
        return `<tr><td>${escapeHtml(member.username)}</td><td>${member.role}</td><td>${formatPoints(member.verified_hashes)}</td><td class="reported-column">${formatHashes(member.reported_hashes)}</td><td>${actions}</td></tr>`;
      }).join("")}</tbody></table>${manager ? `<div class="inline-form"><input id="invite-username" placeholder="Username to invite" /><button data-group-action="invite" type="button">Invite</button></div>` : ""}<div class="group-actions"><button data-group-action="leave" type="button">Leave group</button>${owner ? `<button data-group-action="delete" type="button">Delete group</button>` : ""}</div></div>`;
    }
    groupsContent.querySelectorAll<HTMLButtonElement>("[data-group-action]").forEach((button) => button.addEventListener("click", () => void handleGroupAction(button.dataset.groupAction!, button)));
    groupsContent.querySelectorAll<HTMLButtonElement>("[data-invite-action]").forEach((button) => button.addEventListener("click", () => void handleInviteAction(button.dataset.inviteAction!, Number(button.dataset.inviteId))));
    groupsContent.querySelectorAll<HTMLButtonElement>("[data-member-action]").forEach((button) => button.addEventListener("click", () => void handleMemberAction(button.dataset.memberAction!, Number(button.dataset.memberId), button.dataset.role)));
  } catch (error) {
    showGroupNotice((error as Error).message);
  }
}
async function handleGroupAction(action: string, button: HTMLButtonElement) {
  try {
    showGroupNotice("");
    if (action === "create") {
      await groupRequest("/api/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: document.querySelector<HTMLInputElement>("#new-group-name")!.value, is_open: document.querySelector<HTMLInputElement>("#new-group-open")!.checked }) });
    } else if (action === "join") {
      await groupRequest(`/api/groups/${button.dataset.groupId}/join`, { method: "POST" });
    } else if (action === "update") {
      await groupRequest(`/api/groups/${(await groupRequest("/api/groups/mine") as { group: Group }).group.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: document.querySelector<HTMLInputElement>("#rename-group")!.value, is_open: document.querySelector<HTMLInputElement>("#group-open")!.checked }) });
    } else if (action === "invite") {
      const mine = await groupRequest("/api/groups/mine") as { group: Group };
      await groupRequest(`/api/groups/${mine.group.id}/invite`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: document.querySelector<HTMLInputElement>("#invite-username")!.value }) });
    } else if (action === "leave" || action === "delete") {
      if (!confirm(`Are you sure you want to ${action} this group?`)) return;
      const mine = await groupRequest("/api/groups/mine") as { group: Group };
      await groupRequest(action === "leave" ? `/api/groups/${mine.group.id}/leave` : `/api/groups/${mine.group.id}`, { method: action === "leave" ? "POST" : "DELETE" });
    }
    await refreshGroups();
    await refreshLeaderboard();
  } catch (error) {
    showGroupNotice((error as Error).message);
  }
}
async function handleInviteAction(action: string, inviteId: number) {
  try {
    await groupRequest(`/api/invites/${inviteId}/${action}`, { method: "POST" });
    await refreshGroups();
    await refreshLeaderboard();
  } catch (error) {
    showGroupNotice((error as Error).message);
  }
}
async function handleMemberAction(action: string, memberId: number, role?: string) {
  try {
    const mine = await groupRequest("/api/groups/mine") as { group: Group };
    if (action === "kick") {
      if (!confirm("Kick this member?")) return;
      await groupRequest(`/api/groups/${mine.group.id}/members/${memberId}`, { method: "DELETE" });
    } else {
      await groupRequest(`/api/groups/${mine.group.id}/members/${memberId}/role`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: action === "transfer" ? "owner" : role }) });
    }
    await refreshGroups();
    await refreshLeaderboard();
  } catch (error) {
    showGroupNotice((error as Error).message);
  }
}
async function refreshAccount() {
  const data = await fetch("/api/me").then((response) => response.json() as Promise<{ user: User | null; points: number; rank: number | null; player_count: number; group: Standing["group"] }>);
  currentUser = data.user;
  currentStanding = data.user
    ? { points: data.points, rank: data.rank, player_count: data.player_count, group: data.group }
    : null;
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
  renderStanding();
  void refreshGroups();
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
      progressSinceReport += data.hashes;
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
  progressSinceReport = 0;
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
      void refreshAccount();
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
  progressSinceReport = 0;
  updateStats();
}

accountToggle.addEventListener("click", () => { accountForm.hidden = !accountForm.hidden; });
playersTab.addEventListener("click", () => {
  leaderboardTab = "players";
  playersTab.classList.add("active");
  groupsTab.classList.remove("active");
  void refreshLeaderboard();
});
groupsTab.addEventListener("click", () => {
  leaderboardTab = "groups";
  groupsTab.classList.add("active");
  playersTab.classList.remove("active");
  void refreshLeaderboard();
});
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
setInterval(() => {
  void refreshLeaderboard();
  void refreshGroups();
  void refreshAccount();
}, 30_000);
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN && progressSinceReport > 0) {
    socket.send(JSON.stringify({ type: "progress", hashes: progressSinceReport, threads: Number(threadsSelect.value) }));
    progressSinceReport = 0;
  }
}, 15_000);
updateStats();
void refreshAccount();
void refreshLeaderboard();
void refreshGroups();
void fetch("/api/config").then((response) => response.json() as Promise<Config>).then((config) => {
  if (!config.miningEnabled) showNotice("Mining not configured");
});

heroStart.addEventListener("click", () => document.querySelector(".miner-card")?.scrollIntoView({ behavior: "smooth" }));
heroAccount.addEventListener("click", () => {
  if (currentUser) {
    document.querySelector("#groups-section")?.scrollIntoView({ behavior: "smooth" });
  } else {
    accountForm.hidden = false;
    accountUsername.focus();
  }
});
