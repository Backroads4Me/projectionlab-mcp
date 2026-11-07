import { PROTOCOL_VERSION } from "./types/wire.js";

/**
 * Tier 0 transport: a self-contained snippet the user pastes into the
 * ProjectionLab tab's devtools console. It plays the same executor role as
 * the browser extension - connects to the local WebSocket server, answers
 * ping and request frames against window.projectionlabPluginAPI - but lives
 * only until the tab reloads. Keep the executor logic in sync with
 * extension/src/page-main.js.
 */
export function buildBootstrapSnippet(port: number, token: string): string {
  const cfg = JSON.stringify({ port, token, protocolVersion: PROTOCOL_VERSION });
  return `(() => {
  const cfg = ${cfg};
  if (window.__plmcpBootstrap) { console.log("[plmcp] bootstrap already running"); return; }
  window.__plmcpBootstrap = true;
  let stopped = false;
  const log = (m) => console.log("[plmcp]", m);
  function waitForApi() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      (function poll() {
        if (window.projectionlabPluginAPI) return resolve(window.projectionlabPluginAPI);
        if (Date.now() >= deadline) { const e = new Error("Plugin API did not appear within 15s - log in and enable plugins"); e.code = "API_NOT_AVAILABLE"; return reject(e); }
        setTimeout(poll, 500);
      })();
    });
  }
  function describeApi(api) {
    const out = {}; const seen = new Set(); let o = api;
    while (o && o !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (k === "constructor" || seen.has(k)) continue;
        seen.add(k);
        const v = api[k];
        out[k] = typeof v === "function" ? "function(" + v.length + " args)" : typeof v;
      }
      o = Object.getPrototypeOf(o);
    }
    return out;
  }
  async function handle(frame, ws) {
    try {
      const api = await waitForApi();
      let result;
      if (frame.method === "waitForApi") result = true;
      else if (frame.method === "describeApi") result = describeApi(api);
      else {
        const fn = api[frame.method];
        if (typeof fn !== "function") throw new Error("Plugin API method unavailable: " + frame.method);
        result = await fn.apply(api, frame.params);
      }
      ws.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result }));
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const code = err && err.code === "API_NOT_AVAILABLE" ? "API_NOT_AVAILABLE"
        : /api.?key|invalid key|unauthori[sz]ed/i.test(msg) ? "API_KEY_INVALID" : "UNKNOWN";
      ws.send(JSON.stringify({ type: "response", id: frame.id, ok: false, error: { code, message: msg } }));
    }
  }
  function connect() {
    if (stopped) return;
    const ws = new WebSocket("ws://127.0.0.1:" + cfg.port);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: cfg.token, protocolVersion: cfg.protocolVersion, executor: "bootstrap/0.1.0" }));
    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === "helloAck") log("connected to projectionlab-mcp");
      else if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      else if (frame.type === "request") handle(frame, ws);
    };
    ws.onclose = (ev) => {
      if (stopped) return;
      if (ev.code === 4001 || ev.code === 4002) { stopped = true; window.__plmcpBootstrap = false; log("stopped: " + (ev.reason || ev.code)); return; }
      if (ev.code === 4003) { stopped = true; window.__plmcpBootstrap = false; log("replaced by another executor (probably the extension) - bootstrap no longer needed"); return; }
      log("disconnected; retrying in 3s");
      setTimeout(connect, 3000);
    };
  }
  connect();
  log("bootstrap installed - keep this tab open; re-paste after a page reload");
})();`;
}
