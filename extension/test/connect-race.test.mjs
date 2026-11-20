// background.js connect() awaits storage before it opens a socket, so two
// connects can overlap. These tests load the real service worker against a
// fake browser and WebSocket, hold each config read until the test releases
// it, and check that only one socket is ever opened, that it is the one the
// worker tracks, and that a Save's takeover survives a plain reconnect.

import assert from "node:assert/strict";
import test from "node:test";

let state;

function freshState({ token }) {
  return {
    local: { port: 8788, token, allowEdits: false, instanceId: "test-instance" },
    session: {},
    changed: [],
    sockets: [],
    holdConfig: false,
    heldConfig: [],
    holdSession: false,
    heldSession: [],
  };
}

const pick = (store, defaults) => {
  if (defaults === undefined) return { ...store };
  const out = {};
  for (const [key, fallback] of Object.entries(defaults)) out[key] = key in store ? store[key] : fallback;
  return out;
};
// A read is held while its hold flag is set; release() resolves it later,
// in whatever order the test chooses, with the values storage held when the
// read was made.
function heldRead(store, defaults, hold, queue) {
  const values = pick(store, defaults);
  if (!hold) return Promise.resolve(values);
  return new Promise((resolve) => queue.push({ release: () => resolve(values) }));
}

const browser = {
  runtime: { id: "test-extension", getManifest: () => ({ version: "9.9.9" }), openOptionsPage: async () => {} },
  storage: {
    local: {
      get: (defaults) => heldRead(state.local, defaults, state.holdConfig && defaults && "token" in defaults, state.heldConfig),
      set: async (values) => { Object.assign(state.local, values); },
    },
    session: {
      get: (defaults) => heldRead(state.session, defaults, state.holdSession, state.heldSession),
      set: async (values) => { Object.assign(state.session, values); },
    },
    onChanged: { addListener: (listener) => state.changed.push(listener) },
  },
  alarms: { create: async () => {}, onAlarm: { addListener: () => {} } },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
    onClicked: { addListener: () => {} },
  },
  permissions: { contains: async () => false },
  tabs: {},
  scripting: {},
};
globalThis.chrome = { runtime: { id: "test-extension" } };
globalThis.browser = browser;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    state.sockets.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  serverOpens() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  serverSends(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
globalThis.WebSocket = FakeWebSocket;

const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
let loads = 0;
async function loadWorker() {
  await import(`../src/background.js?load=${++loads}`);
}
const storageChange = (changes) => { for (const listener of state.changed) listener(changes, "local"); };
const openSockets = () => state.sockets.filter((ws) => ws.readyState !== FakeWebSocket.CLOSED);

test("an older connect still reading storage never opens a second socket", async () => {
  state = freshState({ token: "old-token" });
  state.holdConfig = true;
  await loadWorker();
  await settle();
  assert.equal(state.heldConfig.length, 1, "the startup connect waits on its config read");

  // Saving a new token forces a connect while the startup one still waits.
  state.local.token = "new-token";
  storageChange({ token: { oldValue: "old-token", newValue: "new-token" } });
  await settle();
  assert.equal(state.heldConfig.length, 2);

  // The newer read finishes first, the older one after it.
  state.holdConfig = false;
  state.heldConfig[1].release();
  await settle();
  state.heldConfig[0].release();
  await settle();

  assert.equal(state.sockets.length, 1, "only the newest connect opens a socket");
  const [ws] = state.sockets;
  ws.serverOpens();
  await settle();
  assert.equal(ws.sent[0].type, "hello");
  assert.equal(ws.sent[0].takeover, true);
  ws.serverSends({ type: "helloAck", protocolVersion: 1 });
  await settle();

  // The switch reaches the server on the socket the worker tracks.
  ws.sent.length = 0;
  state.local.allowEdits = true;
  storageChange({ allowEdits: { oldValue: false, newValue: true } });
  await settle();
  assert.deepEqual(ws.sent.map((frame) => frame.type), ["settings"]);
  assert.equal(ws.sent[0].allowEdits, true);
});

test("a plain reconnect leaves a Save's takeover connect alone", async () => {
  state = freshState({ token: "token" });
  state.holdSession = true;
  state.holdConfig = true;
  await loadWorker();
  await settle();
  assert.equal(state.heldSession.length, 1, "the startup check waits on session storage");

  // A Save starts a takeover connect, which waits on its config read.
  storageChange({ connectRequestedAt: { oldValue: 1, newValue: 2 } });
  await settle();
  assert.equal(state.heldConfig.length, 1);

  // The startup check now resumes and asks for a plain connect.
  state.holdSession = false;
  state.heldSession[0].release();
  await settle();

  state.holdConfig = false;
  for (const read of state.heldConfig) read.release();
  await settle();

  assert.equal(state.sockets.length, 1);
  assert.equal(openSockets().length, 1);
  state.sockets[0].serverOpens();
  await settle();
  assert.equal(state.sockets[0].sent[0].type, "hello");
  assert.equal(state.sockets[0].sent[0].takeover, true, "the hello still asks to take over");
});
