import browser from "webextension-polyfill";
import { executePageRequest } from "./page-main.js";
import { buildHelloFrame, connectionStatusForClose, delayAfterHelloAck, doubledDelay, isForcedConnectChange, makeResponseFrame, reconnectBlockedForClose, retryDelayForClose, shouldAttemptReconnect, STANDBY_RETRY_MS, statusMessageForClose } from "./wire.js";

const DEFAULT_PORT = 8788;
const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 60_000;
const RECONNECT_ALARM = "plmcp-reconnect";
let socket;
let reconnectTimer;
let retryMs = 2_000;
let lastCloseCode = 0;
let generation = 0;
let reconnectBlocked = false;
const inFlight = new Map();

// The blocked flag and the last attempt time live in storage.session, which
// survives a service-worker restart but clears when the browser closes.
// Chrome terminates the worker about 30 seconds after the socket closes, and
// the reconnect alarm starts it again; without the stored state the restarted
// worker would retry early or outrun the standby schedule.
async function sessionGet(defaults) {
  return browser.storage.session.get(defaults);
}

// One stable id per installation, kept across restarts and browser updates:
// it lets the server tell "this same executor on a new socket" from a second
// browser, so a stale socket never locks the extension out of its own slot.
async function getInstanceId() {
  const { instanceId } = await browser.storage.local.get({ instanceId: "" });
  if (instanceId) return instanceId;
  const fresh = crypto.randomUUID();
  await browser.storage.local.set({ instanceId: fresh });
  return fresh;
}

const EXTENSION_NAME = "MCP Bridge for ProjectionLab";
// Toolbar label per connection status: authed = token accepted by the server,
// connected = socket open and awaiting the server's helloAck, standby = the
// server holds another executor and this one retries slowly. Only authed
// shows a badge: the server runs only while an MCP host does, so being
// disconnected is the normal idle state, and standby needs no badge either.
const STATUS_LABELS = { authed: "connected", connected: "connecting", standby: "standing by", disconnected: "not connected" };

async function showBadge(connectionStatus, lastError) {
  const authed = connectionStatus === "authed";
  const label = STATUS_LABELS[connectionStatus] ?? STATUS_LABELS.disconnected;
  const title = `${EXTENSION_NAME}: ${label}${lastError ? ` - ${lastError}` : ""}`;
  try {
    await browser.action.setBadgeText({ text: authed ? "✓" : "" });
    if (authed) {
      await browser.action.setBadgeBackgroundColor({ color: "#188038" });
      await browser.action.setBadgeTextColor?.({ color: "#ffffff" });
    }
    await browser.action.setTitle({ title });
  } catch {
    // The badge is cosmetic; a failure here must not interrupt the connection.
  }
}

const setStatus = (connectionStatus, lastError = "") => {
  void showBadge(connectionStatus, lastError);
  return browser.storage.local.set({ connectionStatus, lastError });
};
const codedError = (code, message) => Object.assign(new Error(message), { code });

function scheduleReconnect(myGeneration) {
  if (reconnectBlocked || myGeneration !== generation || reconnectTimer) return;
  const delay = retryDelayForClose(retryMs, lastCloseCode);
  retryMs = doubledDelay(delay);
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, delay);
}

async function connect(force = false) {
  if (!force && (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING)) return;
  const myGeneration = ++generation;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (socket) { socket.onclose = null; socket.close(); }
  await browser.storage.session.set({ lastConnectAttemptAt: Date.now() });
  const config = await browser.storage.local.get({ port: DEFAULT_PORT, token: "" });
  if (!config.token) {
    await setStatus("disconnected", "Configure the shared token to connect.");
    return;
  }
  if (force) {
    // Saving the options page is how the user clears a block and asks to
    // become the active browser now.
    reconnectBlocked = false;
    await browser.storage.session.set({ reconnectBlocked: false });
  }
  await setStatus("disconnected");
  const instanceId = await getInstanceId();
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  socket = ws;
  ws.onopen = () => {
    if (myGeneration !== generation) return;
    void setStatus("connected");
    ws.send(JSON.stringify(buildHelloFrame({
      token: config.token,
      protocolVersion: PROTOCOL_VERSION,
      executor: `extension/${browser.runtime.getManifest().version}`,
      instanceId,
      takeover: force,
    })));
  };
  ws.onmessage = (event) => {
    if (myGeneration !== generation) return;
    let frame;
    try { frame = JSON.parse(event.data); }
    catch { void setStatus("connected", "Server sent invalid JSON."); return; }
    if (frame.type === "helloAck") {
      // The slow standby delay survives an accepted hello; an ordinary
      // connection resets the exponential schedule to 2 seconds.
      retryMs = delayAfterHelloAck(lastCloseCode, retryMs);
      // The options page shows a line when the two releases differ; an
      // absent field (older server) stores "" so no stale value lingers.
      void browser.storage.local.set({ serverVersion: frame.serverVersion ?? "" });
      void setStatus("authed");
    }
    else if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    else if (frame.type === "request") void handleRequest(frame, ws);
  };
  ws.onerror = () => void setStatus("disconnected", "WebSocket connection failed.");
  ws.onclose = (event) => {
    if (myGeneration !== generation) return;
    socket = undefined;
    lastCloseCode = event.code;
    // Only 4001/4002 block; 4003 and 4004 retry on the slow standby schedule
    // so the executor reconnects on its own once the active one goes away.
    // The flag is persisted so a service-worker restart honors the block.
    reconnectBlocked = reconnectBlockedForClose(event.code);
    void browser.storage.session.set({ reconnectBlocked });
    void setStatus(connectionStatusForClose(event.code), statusMessageForClose(event));
    scheduleReconnect(myGeneration);
  };
}

async function findProjectionLabTab() {
  const tabs = await browser.tabs.query({ url: "https://app.projectionlab.com/*" });
  if (tabs.length) return tabs[0];
  const { autoOpen } = await browser.storage.local.get({ autoOpen: true });
  if (!autoOpen) throw codedError("NO_TAB", "No ProjectionLab tab is open and auto-open is disabled.");
  try { return await browser.tabs.create({ url: "https://app.projectionlab.com/", active: false }); }
  catch { throw codedError("NO_TAB", "Could not open a ProjectionLab tab."); }
}

async function executeInTab(request) {
  const tab = await findProjectionLabTab();
  if (typeof tab.id !== "number") throw codedError("NO_TAB", "ProjectionLab tab has no usable id.");
  try {
    const injection = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: executePageRequest,
      args: [request],
    });
    if (!injection.length || !injection[0].result) throw codedError("NO_TAB", "ProjectionLab tab returned no result.");
    return injection[0].result;
  } catch (error) {
    if (/tab|receiving end|closed/i.test(error?.message || "")) throw codedError("NO_TAB", "ProjectionLab tab closed while processing the request.");
    throw error;
  }
}

async function handleRequest(request, ws) {
  if (typeof request.id !== "string" || inFlight.has(request.id)) return;
  let timer;
  const operation = executeInTab(request);
  // Promise.race may settle on the timeout first; consume a later operation
  // rejection so it cannot become an unhandled service-worker rejection.
  operation.catch(() => {});
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(codedError("TIMEOUT", "Request timed out after 60 seconds.")), REQUEST_TIMEOUT_MS); });
  inFlight.set(request.id, operation);
  try {
    const response = await Promise.race([operation, timeout]);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(makeResponseFrame(request.id, response)));
  } catch (error) {
    const code = ["NO_TAB", "API_NOT_AVAILABLE", "API_KEY_INVALID", "TIMEOUT"].includes(error?.code) ? error.code : "UNKNOWN";
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "response", id: request.id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }));
  } finally {
    clearTimeout(timer);
    inFlight.delete(request.id);
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && isForcedConnectChange(changes)) void connect(true);
});
browser.action.onClicked.addListener(() => void browser.runtime.openOptionsPage());
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM || socket) return;
  void (async () => {
    const { reconnectBlocked: blocked, lastConnectAttemptAt } = await sessionGet({ reconnectBlocked: false, lastConnectAttemptAt: 0 });
    if (!shouldAttemptReconnect({ blocked, force: false, lastAttemptAt: lastConnectAttemptAt, now: Date.now(), minDelayMs: STANDBY_RETRY_MS })) return;
    void connect();
  })();
});
async function createReconnectAlarm() {
  // Firefox MV3 uses an event page and does not treat WebSocket traffic as
  // activity, so a sub-30-second alarm prevents it from being unloaded. The
  // attempt-time gate keeps standby retries at least STANDBY_RETRY_MS apart.
  const isFirefox = typeof browser.runtime.getBrowserInfo === "function";
  await browser.alarms.create(RECONNECT_ALARM, { periodInMinutes: isFirefox ? 0.25 : 1 });
}
void createReconnectAlarm();
void (async () => {
  // A worker restarted by the reconnect alarm must honor a block persisted
  // before the restart and the standby retry schedule; only saving the
  // options page (forced connect) or a browser restart (which clears
  // storage.session) resumes reconnecting early.
  const { reconnectBlocked: blocked, lastConnectAttemptAt } = await sessionGet({ reconnectBlocked: false, lastConnectAttemptAt: 0 });
  if (!shouldAttemptReconnect({ blocked, force: false, lastAttemptAt: lastConnectAttemptAt, now: Date.now(), minDelayMs: STANDBY_RETRY_MS })) return;
  void connect();
})();
