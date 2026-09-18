import { connect } from "cloudflare:sockets";
import { clampReportedHashes } from "./auth.mjs";
import { createBridge, isValidWallet } from "./bridge.mjs";
import { AppStore } from "./store.mjs";

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function cookieValue(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function sessionCookie(token, maxAge = SESSION_MAX_AGE) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function storeStub(env) {
  return env.STORE.get(env.STORE.idFromName("global"));
}

async function storeRequest(request, env, method, params = {}) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const response = await storeStub(env).fetch("https://store/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: { ...params, ip } })
  });
  return response.json();
}

async function requestBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleWebSocket(request, env) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const token = cookieValue(request, SESSION_COOKIE);
  const identity = (await storeRequest(request, env, "me", { token })).user;
  let closed = false;
  let poolWriter;
  let poolSocket;
  let bridge;
  let lastProgressAt = Date.now();
  let progressThreads = 1;
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    bridge?.close();
    try {
      server.close();
    } catch {}
  };

  bridge = createBridge({
    wallet: env.XMR_WALLET,
    poolFixedDiff: env.POOL_FIXED_DIFF || "",
    sendToClient: (message) => {
      if (!closed) server.send(JSON.stringify(message));
    },
    writeToPool: (text) => poolWriter?.write(new TextEncoder().encode(text)),
    closePool: () => {
      try {
        void poolWriter?.close().catch(() => {});
      } catch {}
      try {
        poolSocket?.close();
      } catch {}
    },
    onShareAccepted: (difficulty) => {
      if (identity?.id && difficulty > 0) {
        void storeRequest(request, env, "recordShare", {
          user_id: identity.id,
          difficulty
        });
      }
    }
  });

  server.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      try {
        const message = JSON.parse(event.data);
        if (message?.type === "progress") {
          progressThreads = Math.max(1, Math.min(16, Number(message.threads) || progressThreads));
          const now = Date.now();
          const reported = clampReportedHashes(message.hashes, progressThreads, now - lastProgressAt);
          lastProgressAt = now;
          if (identity?.id && reported > 0) {
            void storeRequest(request, env, "recordProgress", {
              user_id: identity.id,
              hashes: reported
            });
          }
          return;
        }
      } catch {}
    }
    bridge.onClientMessage(event.data);
  });
  server.addEventListener("close", closeBoth);
  server.addEventListener("error", closeBoth);

  void (async () => {
    try {
      poolSocket = connect({
        hostname: env.POOL_HOST || "pool.supportxmr.com",
        port: Number(env.POOL_PORT || 3333)
      });
      poolWriter = poolSocket.writable.getWriter();
      await poolSocket.opened;
      bridge.onPoolConnect();
      const reader = poolSocket.readable.pipeThrough(new TextDecoderStream()).getReader();
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        bridge.onPoolData(value);
      }
      bridge.onPoolClose();
    } catch (error) {
      bridge.onPoolError(error);
    } finally {
      closeBoth();
    }
  })();

  return new Response(null, { status: 101, webSocket: client });
}

async function handleApi(request, env, url) {
  const storeResponse = (result, fallbackStatus = 200) => json(result, result.status || fallbackStatus);
  const identity = async () => (await storeRequest(request, env, "me", {
    token: cookieValue(request, SESSION_COOKIE)
  })).user;
  const authed = async () => {
    const user = await identity();
    return user ? { user } : null;
  };
  if (url.pathname === "/api/config" && request.method === "GET") {
    return json({ miningEnabled: isValidWallet(env.XMR_WALLET) });
  }
  if (url.pathname === "/api/register" && request.method === "POST") {
    const body = await requestBody(request);
    if (!body) return json({ error: "Invalid request" }, 400);
    const result = await storeRequest(request, env, "register", body);
    return result.token
      ? json({ user: result.user }, 201, { "set-cookie": sessionCookie(result.token) })
      : json(result, 400);
  }
  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await requestBody(request);
    if (!body) return json({ error: "Invalid request" }, 400);
    const result = await storeRequest(request, env, "login", body);
    return result.token
      ? json({ user: result.user }, 200, { "set-cookie": sessionCookie(result.token) })
      : json(result, 401);
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    const token = cookieValue(request, SESSION_COOKIE);
    const result = await storeRequest(request, env, "logout", { token });
    return json(result, 200, { "set-cookie": sessionCookie("", 0) });
  }
  if (url.pathname === "/api/me" && request.method === "GET") {
    const token = cookieValue(request, SESSION_COOKIE);
    return json(await storeRequest(request, env, "me", { token }));
  }
  if (url.pathname === "/api/leaderboard" && request.method === "GET") {
    return json(await storeRequest(request, env, "leaderboard", {
      limit: Number(url.searchParams.get("limit") || 50)
    }));
  }
  if (url.pathname === "/api/leaderboard/groups" && request.method === "GET") {
    return json(await storeRequest(request, env, "leaderboardGroups", {
      limit: Number(url.searchParams.get("limit") || 50)
    }));
  }
  if (url.pathname === "/api/groups" && request.method === "GET") {
    return json(await storeRequest(request, env, "listGroups"));
  }
  const groupMatch = url.pathname.match(/^\/api\/groups\/(\d+)(?:\/members\/(\d+)\/role)?$/);
  const groupActionMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/(join|leave)$/);
  const memberMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/members\/(\d+)$/);
  const inviteMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/invite$/);
  const inviteActionMatch = url.pathname.match(/^\/api\/invites\/(\d+)\/(accept|decline)$/);
  let userSession;
  let sessionLoaded = false;
  const getUserSession = async () => {
    if (!sessionLoaded) {
      userSession = await authed();
      sessionLoaded = true;
    }
    return userSession;
  };
  if (url.pathname === "/api/groups" && request.method === "POST") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    const body = await requestBody(request);
    return storeResponse(await storeRequest(request, env, "createGroup", {
      user_id: userSession.user.id,
      name: body?.name,
      is_open: body?.is_open
    }));
  }
  if (url.pathname === "/api/groups/mine" && request.method === "GET") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    return json(await storeRequest(request, env, "mineGroup", { user_id: userSession.user.id }));
  }
  if (url.pathname === "/api/invites" && request.method === "GET") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    return json(await storeRequest(request, env, "invites", { user_id: userSession.user.id }));
  }
  if (inviteActionMatch && request.method === "POST") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    return storeResponse(await storeRequest(request, env, inviteActionMatch[2] === "accept" ? "acceptInvite" : "declineInvite", {
      user_id: userSession.user.id,
      invite_id: Number(inviteActionMatch[1])
    }));
  }
  if (groupMatch && !groupMatch[2] && request.method === "PATCH") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    const body = await requestBody(request);
    return storeResponse(await storeRequest(request, env, "updateGroup", {
      user_id: userSession.user.id,
      group_id: Number(groupMatch[1]),
      name: body?.name,
      is_open: body?.is_open
    }));
  }
  if (groupMatch && !groupMatch[2] && request.method === "DELETE") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    return storeResponse(await storeRequest(request, env, "deleteGroup", {
      user_id: userSession.user.id,
      group_id: Number(groupMatch[1])
    }));
  }
  if (groupActionMatch && request.method === "POST") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    return storeResponse(await storeRequest(request, env, groupActionMatch[2] === "join" ? "joinGroup" : "leaveGroup", {
      user_id: userSession.user.id,
      group_id: Number(groupActionMatch[1])
    }));
  }
  if (inviteMatch && request.method === "POST") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    const body = await requestBody(request);
    return storeResponse(await storeRequest(request, env, "invite", {
      user_id: userSession.user.id,
      group_id: Number(inviteMatch[1]),
      username: body?.username
    }));
  }
  if (groupMatch && groupMatch[2] && request.method === "POST") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    const body = await requestBody(request);
    return storeResponse(await storeRequest(request, env, "changeRole", {
      user_id: userSession.user.id,
      group_id: Number(groupMatch[1]),
      target_id: Number(groupMatch[2]),
      role: body?.role
    }));
  }
  if (memberMatch && request.method === "DELETE") {
    if (!(await getUserSession())) return json({ error: "Sign in required" }, 401);
    return storeResponse(await storeRequest(request, env, "kick", {
      user_id: userSession.user.id,
      group_id: Number(memberMatch[1]),
      target_id: Number(memberMatch[2])
    }));
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const apiResponse = await handleApi(request, env, url);
    if (apiResponse) return apiResponse;
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "WebSocket upgrade required" }, 426);
      }
      return handleWebSocket(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};

export { AppStore };
