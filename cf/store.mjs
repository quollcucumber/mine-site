import {
  createSessionToken,
  hashPassword,
  hashToken,
  validatePassword,
  validateUsername,
  verifyPassword
} from "./auth.mjs";

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW = 60_000;
const RATE_LIMIT = 10;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export class AppStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.rate = new Map();
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stats (
        user_id INTEGER PRIMARY KEY,
        shares INTEGER NOT NULL DEFAULT 0,
        verified_hashes INTEGER NOT NULL DEFAULT 0,
        last_share_at INTEGER
      );
    `);
  }

  limited(ip) {
    const now = Date.now();
    const timestamps = (this.rate.get(ip) || []).filter((timestamp) => timestamp > now - RATE_WINDOW);
    if (timestamps.length >= RATE_LIMIT) {
      this.rate.set(ip, timestamps);
      return true;
    }
    timestamps.push(now);
    this.rate.set(ip, timestamps);
    return false;
  }

  async request(message) {
    const { method, params = {} } = message;
    if (["register", "login"].includes(method) && this.limited(params.ip || "unknown")) {
      return { error: "Too many attempts" };
    }
    if (method === "register") return this.register(params);
    if (method === "login") return this.login(params);
    if (method === "logout") return this.logout(params);
    if (method === "me") return this.me(params);
    if (method === "recordShare") return this.recordShare(params);
    if (method === "leaderboard") return this.leaderboard(params);
    return { error: "Unknown method" };
  }

  register({ username, password }) {
    return (async () => {
      if (!validateUsername(username)) return { error: "Username must be 3-20 letters, numbers, or underscores" };
      if (!validatePassword(password)) return { error: "Password must be at least 8 characters" };
      const existing = this.ctx.storage.sql.exec("SELECT id FROM users WHERE username = ? COLLATE NOCASE", username).toArray();
      if (existing.length) return { error: "Username already exists" };
      const { hash, salt } = await hashPassword(password);
      const now = Date.now();
      try {
        this.ctx.storage.sql.exec(
          "INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)",
          username,
          hash,
          salt,
          now
        );
      } catch {
        return { error: "Username already exists" };
      }
      const user = this.ctx.storage.sql.exec("SELECT id, username FROM users WHERE username = ?", username).toArray()[0];
      return this.createSession(user);
    })();
  }

  login({ username, password }) {
    return (async () => {
      const user = this.ctx.storage.sql.exec(
        "SELECT id, username, pass_hash, salt FROM users WHERE username = ? COLLATE NOCASE",
        username
      ).toArray()[0];
      if (!user || !(await verifyPassword(password, user.pass_hash, user.salt))) {
        return { error: "Invalid username or password" };
      }
      return this.createSession(user);
    })();
  }

  async createSession(user) {
    const token = createSessionToken();
    const tokenHash = await hashToken(token);
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      tokenHash,
      user.id,
      Date.now() + SESSION_TTL
    );
    return { token, user: { id: user.id, username: user.username } };
  }

  async logout({ token }) {
    if (token) {
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash = ?", await hashToken(token));
    }
    return { ok: true };
  }

  async me({ token }) {
    const session = await this.session(token);
    return { user: session?.user || null };
  }

  async session(token) {
    if (!token) return null;
    const tokenHash = await hashToken(token);
    const row = this.ctx.storage.sql.exec(
      `SELECT s.user_id, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      tokenHash,
      Date.now()
    ).toArray()[0];
    return row ? { id: row.user_id, user: { id: row.user_id, username: row.username } } : null;
  }

  recordShare({ user_id: userId, difficulty }) {
    if (!Number.isInteger(userId) || !Number.isFinite(difficulty) || difficulty <= 0) return { error: "Invalid share" };
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO stats (user_id, shares, verified_hashes, last_share_at) VALUES (?, 1, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         shares = shares + 1,
         verified_hashes = verified_hashes + excluded.verified_hashes,
         last_share_at = excluded.last_share_at`,
      userId,
      Math.floor(difficulty),
      now
    );
    return { ok: true };
  }

  leaderboard({ limit = 50 }) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 50));
    const rows = this.ctx.storage.sql.exec(
      `SELECT u.username, COALESCE(s.shares, 0) AS shares,
              COALESCE(s.verified_hashes, 0) AS verified_hashes
       FROM users u LEFT JOIN stats s ON s.user_id = u.id
       ORDER BY verified_hashes DESC, shares DESC, u.username COLLATE NOCASE ASC
       LIMIT ?`,
      bounded
    ).toArray();
    return {
      leaderboard: rows.map((row, index) => ({
        rank: index + 1,
        username: row.username,
        shares: row.shares,
        verified_hashes: row.verified_hashes
      }))
    };
  }

  async fetch(request) {
    try {
      const message = await request.json();
      return json(await this.request(message));
    } catch {
      return json({ error: "Invalid store request" }, 400);
    }
  }
}
