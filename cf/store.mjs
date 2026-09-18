import {
  createSessionToken,
  hashPassword,
  hashToken,
  validateGroupName,
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

function fail(error, status = 400) {
  return { error, status };
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
        mini_shares INTEGER NOT NULL DEFAULT 0,
        verified_hashes INTEGER NOT NULL DEFAULT 0,
        reported_hashes INTEGER NOT NULL DEFAULT 0,
        last_share_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE COLLATE NOCASE,
        is_open INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_group_per_user ON group_members(user_id);
      CREATE TABLE IF NOT EXISTS group_invites (
        id INTEGER PRIMARY KEY,
        group_id INTEGER NOT NULL,
        invitee_id INTEGER NOT NULL,
        inviter_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (group_id, invitee_id)
      );
    `);
    try {
      this.ctx.storage.sql.exec("ALTER TABLE stats ADD COLUMN reported_hashes INTEGER NOT NULL DEFAULT 0");
    } catch {}
    try {
      this.ctx.storage.sql.exec("ALTER TABLE stats ADD COLUMN mini_shares INTEGER NOT NULL DEFAULT 0");
    } catch {}
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
      return fail("Too many attempts", 429);
    }
    if (method === "register") return this.register(params);
    if (method === "login") return this.login(params);
    if (method === "logout") return this.logout(params);
    if (method === "me") return this.me(params);
    if (method === "recordShare") return this.recordShare(params);
    if (method === "recordMiniShare") return this.recordMiniShare(params);
    if (method === "recordProgress") return this.recordProgress(params);
    if (method === "leaderboard") return this.leaderboard(params);
    if (method === "leaderboardGroups") return this.leaderboardGroups(params);
    if (method === "createGroup") return this.createGroup(params);
    if (method === "listGroups") return this.listGroups();
    if (method === "mineGroup") return this.mineGroup(params);
    if (method === "updateGroup") return this.updateGroup(params);
    if (method === "deleteGroup") return this.deleteGroup(params);
    if (method === "joinGroup") return this.joinGroup(params);
    if (method === "leaveGroup") return this.leaveGroup(params);
    if (method === "invite") return this.invite(params);
    if (method === "changeRole") return this.changeRole(params);
    if (method === "kick") return this.kick(params);
    if (method === "invites") return this.invites(params);
    if (method === "acceptInvite") return this.acceptInvite(params);
    if (method === "declineInvite") return this.declineInvite(params);
    return fail("Unknown method", 404);
  }

  register({ username, password }) {
    return (async () => {
      if (!validateUsername(username)) return fail("Username must be 3-20 letters, numbers, or underscores");
      if (!validatePassword(password)) return fail("Password must be at least 8 characters");
      const existing = this.ctx.storage.sql.exec("SELECT id FROM users WHERE username = ? COLLATE NOCASE", username).toArray();
      if (existing.length) return fail("Username already exists", 409);
      const { hash, salt } = await hashPassword(password);
      try {
        this.ctx.storage.sql.exec(
          "INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)",
          username,
          hash,
          salt,
          Date.now()
        );
      } catch {
        return fail("Username already exists", 409);
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
        return fail("Invalid username or password", 401);
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
    if (token) this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash = ?", await hashToken(token));
    return { ok: true };
  }

  async session(token) {
    if (!token) return null;
    const row = this.ctx.storage.sql.exec(
      `SELECT s.user_id, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      await hashToken(token),
      Date.now()
    ).toArray()[0];
    return row ? { id: row.user_id, user: { id: row.user_id, username: row.username } } : null;
  }

  async me({ token }) {
    const session = await this.session(token);
    if (!session) return { user: null, points: 0, mini_shares: 0, rank: null, player_count: 0, group: null };
    const player = this.ctx.storage.sql.exec(
      `WITH player_scores AS (
         SELECT u.id AS user_id,
                u.username,
                COALESCE(s.mini_shares, 0) AS mini_shares,
                COALESCE(s.shares, 0) AS shares,
                COALESCE(s.verified_hashes, 0) AS verified_hashes,
                COALESCE(s.reported_hashes, 0) AS reported_hashes,
                512 * COALESCE(s.mini_shares, 0) + 20000 * COALESCE(s.shares, 0) AS points
         FROM users u LEFT JOIN stats s ON s.user_id = u.id
       )
       SELECT ps.points, ps.mini_shares, ps.shares, ps.verified_hashes, ps.reported_hashes,
              (SELECT COUNT(*) FROM player_scores higher
               WHERE higher.points > ps.points
                  OR (higher.points = ps.points
                      AND higher.shares > ps.shares)
                  OR (higher.points = ps.points
                      AND higher.shares = ps.shares
                      AND higher.username COLLATE NOCASE < ps.username COLLATE NOCASE)) + 1 AS rank,
              (SELECT COUNT(*) FROM player_scores) AS player_count
       FROM player_scores ps
       WHERE ps.user_id = ?`,
      session.id
    ).toArray()[0];
    const group = this.ctx.storage.sql.exec(
      `WITH group_scores AS (
         SELECT g.id, g.name,
                COALESCE(SUM(COALESCE(s.mini_shares, 0)), 0) AS mini_shares,
                COALESCE(SUM(COALESCE(s.shares, 0)), 0) AS shares,
                COALESCE(SUM(512 * COALESCE(s.mini_shares, 0) + 20000 * COALESCE(s.shares, 0)), 0) AS points
         FROM groups g
         LEFT JOIN group_members gm ON gm.group_id = g.id
         LEFT JOIN stats s ON s.user_id = gm.user_id
         GROUP BY g.id
       )
       SELECT gs.id, gs.name,
               (SELECT COUNT(*) FROM group_scores higher
               WHERE higher.points > gs.points
                  OR (higher.points = gs.points
                      AND higher.shares > gs.shares)
                  OR (higher.points = gs.points
                      AND higher.shares = gs.shares
                      AND higher.name COLLATE NOCASE < gs.name COLLATE NOCASE)) + 1 AS rank
       FROM group_scores gs
       JOIN group_members gm ON gm.group_id = gs.id
       WHERE gm.user_id = ?`,
      session.id
    ).toArray()[0] || null;
    return {
      user: session.user,
      verified_hashes: player?.verified_hashes || 0,
      reported_hashes: player?.reported_hashes || 0,
      mini_shares: player?.mini_shares || 0,
      shares: player?.shares || 0,
      points: player?.points || 0,
      rank: player?.rank || null,
      player_count: player?.player_count || 0,
      group: group ? { id: group.id, name: group.name, rank: group.rank } : null
    };
  }

  recordShare({ user_id: userId, difficulty }) {
    if (!Number.isInteger(userId) || !Number.isFinite(difficulty) || difficulty <= 0) return fail("Invalid share");
    this.ctx.storage.sql.exec(
      `INSERT INTO stats (user_id, shares, verified_hashes, reported_hashes, last_share_at) VALUES (?, 1, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         shares = shares + 1,
         verified_hashes = verified_hashes + excluded.verified_hashes,
         last_share_at = excluded.last_share_at`,
      userId,
      Math.floor(difficulty),
      Date.now()
    );
    return { ok: true };
  }

  recordMiniShare({ user_id: userId }) {
    if (!Number.isInteger(userId)) return fail("Invalid mini-share");
    this.ctx.storage.sql.exec(
      `INSERT INTO stats (user_id, mini_shares, shares, verified_hashes, reported_hashes, last_share_at)
       VALUES (?, 1, 0, 0, 0, NULL)
       ON CONFLICT(user_id) DO UPDATE SET mini_shares = mini_shares + 1`,
      userId
    );
    return { ok: true };
  }

  recordProgress({ user_id: userId, hashes }) {
    if (!Number.isInteger(userId) || !Number.isFinite(hashes) || hashes < 0) return fail("Invalid progress");
    this.ctx.storage.sql.exec(
      `INSERT INTO stats (user_id, shares, verified_hashes, reported_hashes, last_share_at) VALUES (?, 0, 0, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET reported_hashes = reported_hashes + excluded.reported_hashes`,
      userId,
      Math.floor(hashes)
    );
    return { ok: true };
  }

  leaderboard({ limit = 50 }) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 50));
    const rows = this.ctx.storage.sql.exec(
      `SELECT u.username, COALESCE(s.mini_shares, 0) AS mini_shares,
              COALESCE(s.shares, 0) AS shares,
              COALESCE(s.verified_hashes, 0) AS verified_hashes,
              COALESCE(s.reported_hashes, 0) AS reported_hashes,
              512 * COALESCE(s.mini_shares, 0) + 20000 * COALESCE(s.shares, 0) AS points,
              g.name AS group_name
       FROM users u LEFT JOIN stats s ON s.user_id = u.id
       LEFT JOIN group_members gm ON gm.user_id = u.id
       LEFT JOIN groups g ON g.id = gm.group_id
       ORDER BY points DESC, shares DESC, u.username COLLATE NOCASE ASC
       LIMIT ?`,
      bounded
    ).toArray();
    return {
      leaderboard: rows.map((row, index) => ({
        rank: index + 1,
        username: row.username,
        points: row.points,
        mini_shares: row.mini_shares,
        shares: row.shares,
        verified_hashes: row.verified_hashes,
        reported_hashes: row.reported_hashes,
        group_name: row.group_name || null
      }))
    };
  }

  leaderboardGroups({ limit = 50 }) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 50));
    const rows = this.ctx.storage.sql.exec(
      `SELECT g.name, COUNT(gm.user_id) AS member_count,
              COALESCE(SUM(COALESCE(s.mini_shares, 0)), 0) AS mini_shares,
              COALESCE(SUM(COALESCE(s.shares, 0)), 0) AS shares,
              COALESCE(SUM(512 * COALESCE(s.mini_shares, 0) + 20000 * COALESCE(s.shares, 0)), 0) AS points
       FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id
       LEFT JOIN stats s ON s.user_id = gm.user_id
       GROUP BY g.id
       ORDER BY points DESC, shares DESC, g.name COLLATE NOCASE ASC
       LIMIT ?`,
      bounded
    ).toArray();
    return { leaderboard: rows };
  }

  groupMembership(userId, groupId) {
    return this.ctx.storage.sql.exec(
      "SELECT gm.group_id, gm.user_id, gm.role, g.name, g.is_open FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? AND gm.group_id = ?",
      userId,
      groupId
    ).toArray()[0];
  }

  anyMembership(userId) {
    return this.ctx.storage.sql.exec("SELECT group_id, role FROM group_members WHERE user_id = ?", userId).toArray()[0];
  }

  createGroup({ user_id: userId, name, is_open: isOpen = true }) {
    if (!validateGroupName(name)) return fail("Group name must be 3-24 characters using letters, numbers, spaces, _ or -");
    if (this.anyMembership(userId)) return fail("Leave your current group first", 400);
    let group;
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO groups (name, is_open, created_by, created_at) VALUES (?, ?, ?, ?)",
        name,
        isOpen ? 1 : 0,
        userId,
        Date.now()
      );
      group = this.ctx.storage.sql.exec("SELECT id, name, is_open FROM groups WHERE name = ?", name).toArray()[0];
      this.ctx.storage.sql.exec(
        "INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
        group.id,
        userId,
        Date.now()
      );
    } catch {
      return fail("Group name already exists", 409);
    }
    this.ctx.storage.sql.exec("DELETE FROM group_invites WHERE invitee_id = ?", userId);
    return { ok: true, group };
  }

  listGroups() {
    return {
      groups: this.ctx.storage.sql.exec(
        `SELECT g.id, g.name, COUNT(gm.user_id) AS member_count
         FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id
         WHERE g.is_open = 1 GROUP BY g.id ORDER BY g.name COLLATE NOCASE ASC`
      ).toArray()
    };
  }

  mineGroup({ user_id: userId }) {
    const membership = this.ctx.storage.sql.exec(
      "SELECT gm.group_id, gm.role, g.name, g.is_open FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ?",
      userId
    ).toArray()[0];
    if (!membership) return { group: null, members: [], my_role: null };
    const members = this.ctx.storage.sql.exec(
      `SELECT u.id AS user_id, u.username, gm.role,
              COALESCE(s.mini_shares, 0) AS mini_shares,
              COALESCE(s.shares, 0) AS shares,
              512 * COALESCE(s.mini_shares, 0) + 20000 * COALESCE(s.shares, 0) AS points
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       LEFT JOIN stats s ON s.user_id = gm.user_id
       WHERE gm.group_id = ?
       ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.username COLLATE NOCASE ASC`,
      membership.group_id
    ).toArray();
    return {
      group: { id: membership.group_id, name: membership.name, is_open: Boolean(membership.is_open) },
      members,
      my_role: membership.role
    };
  }

  updateGroup({ user_id: userId, group_id: groupId, name, is_open: isOpen }) {
    const membership = this.groupMembership(userId, groupId);
    if (!membership || membership.role !== "owner") return fail("Only the owner can update this group", 403);
    if (name !== undefined && !validateGroupName(name)) return fail("Invalid group name");
    try {
      if (name !== undefined && isOpen !== undefined) {
        this.ctx.storage.sql.exec("UPDATE groups SET name = ?, is_open = ? WHERE id = ?", name, isOpen ? 1 : 0, groupId);
      } else if (name !== undefined) {
        this.ctx.storage.sql.exec("UPDATE groups SET name = ? WHERE id = ?", name, groupId);
      } else if (isOpen !== undefined) {
        this.ctx.storage.sql.exec("UPDATE groups SET is_open = ? WHERE id = ?", isOpen ? 1 : 0, groupId);
      }
    } catch {
      return fail("Group name already exists", 409);
    }
    return { ok: true };
  }

  deleteGroup({ user_id: userId, group_id: groupId }) {
    const membership = this.groupMembership(userId, groupId);
    if (!membership || membership.role !== "owner") return fail("Only the owner can delete this group", 403);
    this.ctx.storage.sql.exec("DELETE FROM group_invites WHERE group_id = ?", groupId);
    this.ctx.storage.sql.exec("DELETE FROM group_members WHERE group_id = ?", groupId);
    this.ctx.storage.sql.exec("DELETE FROM groups WHERE id = ?", groupId);
    return { ok: true };
  }

  joinGroup({ user_id: userId, group_id: groupId }) {
    const group = this.ctx.storage.sql.exec("SELECT id, name, is_open FROM groups WHERE id = ?", groupId).toArray()[0];
    if (!group) return fail("Group not found", 404);
    if (!group.is_open) return fail("This group is invite-only", 403);
    if (this.anyMembership(userId)) return fail("Leave your current group first", 400);
    this.ctx.storage.sql.exec(
      "INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
      groupId,
      userId,
      Date.now()
    );
    this.ctx.storage.sql.exec("DELETE FROM group_invites WHERE invitee_id = ?", userId);
    return { ok: true };
  }

  leaveGroup({ user_id: userId, group_id: groupId }) {
    const membership = this.groupMembership(userId, groupId);
    if (!membership) return fail("You are not in this group", 400);
    if (membership.role === "owner") {
      const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?", groupId).toArray()[0].count;
      if (count > 1) return fail("Transfer ownership before leaving", 400);
      return this.deleteGroup({ user_id: userId, group_id: groupId });
    }
    this.ctx.storage.sql.exec("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", groupId, userId);
    this.ctx.storage.sql.exec("DELETE FROM group_invites WHERE invitee_id = ?", userId);
    return { ok: true };
  }

  invite({ user_id: userId, group_id: groupId, username }) {
    const membership = this.groupMembership(userId, groupId);
    if (!membership || !["owner", "admin"].includes(membership.role)) return fail("Only owners and admins can invite", 403);
    const invitee = this.ctx.storage.sql.exec("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE", username).toArray()[0];
    if (!invitee) return fail("User not found", 404);
    if (this.anyMembership(invitee.id)) return fail("User is already in a group", 400);
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO group_invites (group_id, invitee_id, inviter_id, created_at) VALUES (?, ?, ?, ?)",
        groupId,
        invitee.id,
        userId,
        Date.now()
      );
    } catch {
      return fail("User already has an invite", 409);
    }
    return { ok: true };
  }

  changeRole({ user_id: userId, group_id: groupId, target_id: targetId, role }) {
    const actor = this.groupMembership(userId, groupId);
    const target = this.groupMembership(targetId, groupId);
    if (!actor || actor.role !== "owner") return fail("Only the owner can change roles", 403);
    if (!target || !["admin", "member", "owner"].includes(role)) return fail("Invalid member or role");
    if (role === "owner") {
      if (target.role === "owner") return fail("User is already the owner");
      this.ctx.storage.sql.exec("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?", groupId, userId);
      this.ctx.storage.sql.exec("UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?", groupId, targetId);
    } else {
      this.ctx.storage.sql.exec("UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?", role, groupId, targetId);
    }
    return { ok: true };
  }

  kick({ user_id: userId, group_id: groupId, target_id: targetId }) {
    const actor = this.groupMembership(userId, groupId);
    const target = this.groupMembership(targetId, groupId);
    if (!actor || !target) return fail("Member not found", 404);
    if (actor.role === "owner" && targetId === userId) return fail("Use leave to leave the group");
    if (actor.role === "admin" && target.role !== "member") return fail("Admins can only kick members", 403);
    if (!["owner", "admin"].includes(actor.role)) return fail("Only owners and admins can kick", 403);
    this.ctx.storage.sql.exec("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", groupId, targetId);
    this.ctx.storage.sql.exec("DELETE FROM group_invites WHERE invitee_id = ?", targetId);
    return { ok: true };
  }

  invites({ user_id: userId }) {
    return {
      invites: this.ctx.storage.sql.exec(
        `SELECT i.id, i.group_id, g.name, g.is_open, u.username AS inviter
         FROM group_invites i JOIN groups g ON g.id = i.group_id
         JOIN users u ON u.id = i.inviter_id
         WHERE i.invitee_id = ? ORDER BY i.created_at DESC`,
        userId
      ).toArray()
    };
  }

  acceptInvite({ user_id: userId, invite_id: inviteId }) {
    if (this.anyMembership(userId)) return fail("Leave your current group first");
    const invite = this.ctx.storage.sql.exec("SELECT group_id FROM group_invites WHERE id = ? AND invitee_id = ?", inviteId, userId).toArray()[0];
    if (!invite) return fail("Invite not found", 404);
    this.ctx.storage.sql.exec(
      "INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
      invite.group_id,
      userId,
      Date.now()
    );
    this.ctx.storage.sql.exec("DELETE FROM group_invites WHERE invitee_id = ?", userId);
    return { ok: true };
  }

  declineInvite({ user_id: userId, invite_id: inviteId }) {
    this.ctx.storage.sql.exec("DELETE FROM group_invites WHERE id = ? AND invitee_id = ?", inviteId, userId);
    return { ok: true };
  }

  async fetch(request) {
    try {
      const result = await this.request(await request.json());
      return json(result, result.status || 200);
    } catch {
      return json({ error: "Invalid store request" }, 400);
    }
  }
}
