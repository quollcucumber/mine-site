import { connect } from "cloudflare:sockets";
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

  server.addEventListener("message", (event) => bridge.onClientMessage(event.data));
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
