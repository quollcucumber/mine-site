import { connect } from "cloudflare:sockets";
import { createBridge, isValidWallet } from "../server/bridge.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function handleWebSocket(request, env) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  let closed = false;
  let poolWriter;
  let poolSocket;
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    bridge.close();
    try {
      server.close();
    } catch {}
  };
  const bridge = createBridge({
    wallet: env.XMR_WALLET,
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config" && request.method === "GET") {
      return json({ miningEnabled: isValidWallet(env.XMR_WALLET) });
    }
    if (url.pathname === "/ws" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return handleWebSocket(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
