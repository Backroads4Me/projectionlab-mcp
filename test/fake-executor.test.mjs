// Integration test for ExtensionBridge: plays the browser-side executor over
// a real WebSocket and exercises every Bridge method plus auth-rejection,
// replacement, disconnect, and timeout paths. No browser or Playwright needed.
//
// Run: node --test test/fake-executor.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 18788;
const TOKEN = "test-token";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_TRANSPORT = "extension";
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = TOKEN;
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { PROTOCOL_VERSION, CLOSE_CODES } = await import("../dist/types/wire.js");

/** Minimal scriptable executor: answers requests via the supplied handler. */
function connectExecutor({ token = TOKEN, protocolVersion = PROTOCOL_VERSION, handler } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const events = { closed: null, acked: false };
  const done = new Promise((resolve) => {
    ws.on("close", (code) => {
      events.closed = code;
      resolve(events);
    });
  });
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", token, protocolVersion, executor: "fake/1.0" }));
  });
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === "helloAck") events.acked = true;
    if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    if (frame.type === "request" && handler) {
      const reply = handler(frame);
      if (reply) ws.send(JSON.stringify({ type: "response", id: frame.id, ...reply }));
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.on("message", (raw) => {
      if (JSON.parse(String(raw)).type === "helloAck") resolve(ws);
    });
    ws.on("close", () => reject(new Error("closed before helloAck")));
    ws.on("error", reject);
  });
  ready.catch(() => {}); // rejection tests never await ready; keep it handled
  return { ws, ready, done, events };
}

/** Handler mimicking a healthy PL tab. */
function healthyHandler(frame) {
  const [first] = frame.params;
  switch (frame.method) {
    case "waitForApi":
      return { ok: true };
    case "validateApiKey":
      return first?.key === "test-api-key"
        ? { ok: true }
        : { ok: false, error: { code: "API_KEY_INVALID", message: "bad key" } };
    case "describeApi":
      return { ok: true, result: { exportData: "function(1 args)" } };
    case "exportData":
      return { ok: true, result: { plans: [], today: { accounts: [] }, exportedAt: 1 } };
    case "updateAccount":
    case "restoreCurrentFinances":
    case "restorePlans":
    case "restoreProgress":
    case "restoreSettings":
      return { ok: true };
    default:
      return { ok: false, error: { code: "UNKNOWN", message: `unexpected ${frame.method}` } };
  }
}

const bridge = new ExtensionBridge();
await new Promise((r) => setTimeout(r, 100)); // let the server start listening

test("rejects wrong token with AUTH_FAILED", async () => {
  const { done } = connectExecutor({ token: "wrong" });
  const { closed, acked } = await done;
  assert.equal(closed, CLOSE_CODES.AUTH_FAILED);
  assert.equal(acked, false);
});

test("rejects protocol mismatch with VERSION_MISMATCH", async () => {
  const { done } = connectExecutor({ protocolVersion: 999 });
  const { closed } = await done;
  assert.equal(closed, CLOSE_CODES.VERSION_MISMATCH);
});

test("checkConnection with no executor reports EXTENSION_NOT_CONNECTED", async () => {
  const status = await bridge.checkConnection();
  assert.equal(status.browser, false);
  assert.match(status.errors[0], /EXTENSION_NOT_CONNECTED/);
});

test("all Bridge methods round-trip through a healthy executor", async () => {
  const exec = connectExecutor({ handler: healthyHandler });
  await exec.ready;

  const status = await bridge.checkConnection();
  assert.deepEqual(status, {
    browser: true,
    pageLoaded: true,
    apiAvailable: true,
    apiKeyValid: true,
    errors: [],
  });

  assert.deepEqual(await bridge.describePluginApi(), { exportData: "function(1 args)" });

  const data = await bridge.exportData();
  assert.deepEqual(data.plans, []);
  // Second call must hit the cache (handler would still work, but verify identity)
  assert.equal(await bridge.exportData(), data);

  await bridge.updateAccount("acct-1", { balance: 100 }, true);
  // Write invalidated the cache: next export is a fresh object
  assert.notEqual(await bridge.exportData(), data);

  await bridge.restoreCurrentFinances({});
  await bridge.restorePlans([]);
  await bridge.restoreProgress({});
  await bridge.restoreSettings({});
  exec.ws.close();
  await exec.done;
});

test("executor wire errors map to ProjectionLabError codes", async () => {
  const exec = connectExecutor({
    handler: (frame) =>
      frame.method === "exportData"
        ? { ok: false, error: { code: "API_KEY_INVALID", message: "rejected" } }
        : { ok: false, error: { code: "NO_TAB", message: "no tab" } },
  });
  await exec.ready;

  await assert.rejects(bridge.exportData({ fresh: true }), (err) => {
    assert.equal(err.code, "API_KEY_INVALID");
    return true;
  });
  await assert.rejects(bridge.updateAccount("a", {}), (err) => {
    assert.equal(err.code, "PAGE_NOT_LOADED");
    return true;
  });
  exec.ws.close();
  await exec.done;
});

test("newest executor wins; old socket closed with REPLACED", async () => {
  const first = connectExecutor({ handler: healthyHandler });
  await first.ready;
  const second = connectExecutor({ handler: healthyHandler });
  await second.ready;
  const { closed } = await first.done;
  assert.equal(closed, CLOSE_CODES.REPLACED);
  // Bridge still works via the second executor
  assert.ok(await bridge.describePluginApi());
  second.ws.close();
  await second.done;
});

test("disconnect mid-request rejects pending calls", async () => {
  const exec = connectExecutor({
    handler: (frame) => {
      if (frame.method === "exportData") {
        setTimeout(() => exec.ws.close(), 50); // never answer; hang up instead
        return null;
      }
      return healthyHandler(frame);
    },
  });
  await exec.ready;
  await assert.rejects(bridge.exportData({ fresh: true }), (err) => {
    assert.equal(err.code, "EXTENSION_NOT_CONNECTED");
    return true;
  });
  await exec.done;
});

test("close() shuts down cleanly and further calls fail fast", async () => {
  await bridge.close();
  await assert.rejects(bridge.describePluginApi(), (err) => {
    assert.equal(err.code, "EXTENSION_NOT_CONNECTED");
    return true;
  });
});
