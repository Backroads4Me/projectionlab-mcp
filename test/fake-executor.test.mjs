// Integration test for ExtensionBridge: plays the browser-side executor over
// a real WebSocket and exercises every Bridge method plus auth-rejection,
// replacement, disconnect, and timeout paths. No browser or Playwright needed.
//
// Run: node --test test/fake-executor.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();
const TOKEN = "test-token";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = TOKEN;
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { PROTOCOL_VERSION, CLOSE_CODES } = await import("../dist/types/wire.js");

/** Minimal scriptable executor: answers requests via the supplied handler.
 * `hello` adds extra hello fields (takeover, instanceId). */
function connectExecutor({ token = TOKEN, protocolVersion = PROTOCOL_VERSION, executor = "fake/1.0", handler, hello = {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const events = { closed: null, acked: false };
  const done = new Promise((resolve) => {
    ws.on("close", (code) => {
      events.closed = code;
      resolve(events);
    });
  });
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", token, protocolVersion, executor, ...hello }));
  });
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === "helloAck") {
      events.acked = true;
      events.ack = frame;
    }
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
    executor: "fake/1.0",
    apiContract: 1,
    errors: [],
  });

  assert.deepEqual(await bridge.describePluginApi(), { exportData: "function(1 args)" });

  const data = await bridge.exportData();
  assert.deepEqual(data.plans, []);
  // Second call must hit the cache (handler would still work, but verify identity)
  assert.equal(await bridge.exportData(), data);

  await bridge.updateAccount("acct-1", { balance: 100 }, true, "v4");
  // Write invalidated the cache: next export is a fresh object
  assert.notEqual(await bridge.exportData(), data);

  await bridge.restoreCurrentFinances({}, "v4");
  await bridge.restorePlans([], "v4");
  await bridge.restoreProgress({}, "v4");
  await bridge.restoreSettings({}, "v4");
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
  await assert.rejects(bridge.updateAccount("a", {}, undefined, "v4"), (err) => {
    assert.equal(err.code, "PAGE_NOT_LOADED");
    return true;
  });
  exec.ws.close();
  await exec.done;
});

test("a connection-check error line ends its message with exactly one period", async () => {
  // The extension's NO_TAB messages already end in a period.
  const exec = connectExecutor({
    handler: () => ({ ok: false, error: { code: "NO_TAB", message: "No ProjectionLab tab is open and auto-open is disabled." } }),
  });
  await exec.ready;
  const status = await bridge.checkConnection();
  assert.equal(status.pageLoaded, false);
  assert.match(status.errors[0], /^PAGE_NOT_LOADED: No ProjectionLab tab: No ProjectionLab tab is open and auto-open is disabled\. Open /);
  exec.ws.close();
  await exec.done;
});

test("a takeover replaces the incumbent; old socket closed with REPLACED", async () => {
  const first = connectExecutor({ handler: healthyHandler });
  await first.ready;
  const second = connectExecutor({ handler: healthyHandler, hello: { takeover: true } });
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

test("concurrent cold reads share one exportData round trip", async () => {
  let exportCalls = 0;
  const exec = connectExecutor({
    handler(frame) {
      if (frame.method !== "exportData") return healthyHandler(frame);
      exportCalls++;
      // Answer slowly so the second read queues behind the first.
      setTimeout(() => {
        exec.ws.send(JSON.stringify({
          type: "response",
          id: frame.id,
          ok: true,
          result: { plans: [], today: {}, exportedAt: exportCalls },
        }));
      }, 100);
      return undefined;
    },
  });
  await exec.ready;
  await bridge.restorePlans([], "v4"); // a write clears the export cache

  const [a, b] = await Promise.all([bridge.exportData(), bridge.exportData()]);
  assert.equal(exportCalls, 1);
  assert.equal(a, b);

  // A fresh read still goes to the tab.
  await bridge.exportData({ fresh: true });
  assert.equal(exportCalls, 2);
  exec.ws.close();
  await exec.done;
});

test("a malformed frame before hello closes that socket and the server keeps serving", async () => {
  // A raw client that completes the upgrade, then sends an unmasked text
  // frame, which RFC 6455 5.1 forbids from a client.
  const raw = net.connect(PORT, "127.0.0.1");
  await new Promise((resolve, reject) => {
    raw.once("connect", resolve);
    raw.once("error", reject);
  });
  raw.write(
    "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  await new Promise((resolve) => raw.once("data", resolve));
  const closed = new Promise((resolve) => raw.once("close", resolve));
  raw.on("error", () => {});
  raw.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
  await closed;

  const exec = connectExecutor({ handler: healthyHandler });
  await exec.ready;
  assert.ok(await bridge.describePluginApi());
  exec.ws.close();
  await exec.done;
});

test("a connection that sends too much before hello is dropped at once", async () => {
  const raw = net.connect(PORT, "127.0.0.1");
  await new Promise((resolve, reject) => {
    raw.once("connect", resolve);
    raw.once("error", reject);
  });
  raw.write(
    "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  await new Promise((resolve) => raw.once("data", resolve));
  raw.on("error", () => {});
  const closed = new Promise((resolve) => raw.once("close", resolve));
  const started = Date.now();
  // A masked text frame announcing 1 MiB (RFC 6455 5.2), then 128 KiB of it.
  const header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(1024n * 1024n, 2);
  raw.write(Buffer.concat([header, Buffer.alloc(128 * 1024)]));
  await closed;
  // Well before the 5-second hello timeout, which would also close it.
  assert.ok(Date.now() - started < 2_000, `closed after ${Date.now() - started}ms`);

  const exec = connectExecutor({ handler: healthyHandler });
  await exec.ready;
  assert.ok(await bridge.describePluginApi());
  exec.ws.close();
  await exec.done;
});

test("helloAck carries the server release and checkConnection names the executor", async () => {
  const { VERSION } = await import("../dist/version.js");
  const exec = connectExecutor({ executor: "extension/9.9.9", handler: healthyHandler });
  await exec.ready;
  assert.equal(exec.events.ack.protocolVersion, PROTOCOL_VERSION);
  assert.equal(exec.events.ack.serverVersion, VERSION);
  const status = await bridge.checkConnection();
  assert.equal(status.executor, "extension/9.9.9");
  exec.ws.close();
});

/** A ProjectionLab 5 page: healthyHandler plus api.version 2 and a v5
 * export, recording every method the server asks for. */
function v5Handler(seen) {
  return (frame) => {
    seen.push(frame.method);
    if (frame.method === "apiVersion") return { ok: true, result: 2 };
    if (frame.method === "exportData") return { ok: true, result: { schema: 1, exportedAt: 1, documents: { plans: [] } } };
    return healthyHandler(frame);
  };
}

test("checkConnection reports contract 2 on a ProjectionLab 5 page", async () => {
  const exec = connectExecutor({ handler: v5Handler([]) });
  await exec.ready;
  const status = await bridge.checkConnection();
  assert.equal(status.apiContract, 2);
  // The resources choose their text from this without contacting the page.
  assert.equal(bridge.knownApiContract(), 2);
  assert.equal(status.apiKeyValid, true);
  assert.deepEqual(status.errors, []);
  exec.ws.close();
  await exec.done;
});

test("restoreProgress is refused on contract 2 before anything is sent", async () => {
  const seen = [];
  const exec = connectExecutor({ handler: v5Handler(seen) });
  await exec.ready;
  await assert.rejects(bridge.restoreProgress({}, "v5"), (err) => {
    assert.equal(err.code, "WRITE_NOT_SUPPORTED");
    assert.equal(err.message, "ProjectionLab 5 removed restoreProgress");
    return true;
  });
  assert.deepEqual(seen.filter((m) => m !== "apiVersion"), []);
  exec.ws.close();
  await exec.done;
});

test("plan, Current Finances and settings writes reach a contract 2 page", async () => {
  const seen = [];
  const exec = connectExecutor({ handler: v5Handler(seen) });
  await exec.ready;
  await bridge.restorePlans([], "v5");
  await bridge.restorePlansIfUnchanged([], [], "v5");
  await bridge.updateAccount("a", { balance: 1 }, undefined, "v5");
  await bridge.restoreCurrentFinances({}, "v5");
  await bridge.restoreSettings({}, "v5");
  const writes = ["restorePlans", "updateAccount", "restoreCurrentFinances", "restoreSettings"];
  assert.deepEqual(
    seen.filter((m) => writes.includes(m)),
    ["restorePlans", "restorePlans", "updateAccount", "restoreCurrentFinances", "restoreSettings"],
  );
  // A write prepared from ProjectionLab 4 data is still refused.
  await assert.rejects(bridge.restorePlans([], "v4"), (err) => err.code === "CONTRACT_CHANGED");
  await assert.rejects(
    bridge.updateAccount("a", { balance: 1 }, undefined, "v4"),
    (err) => err.code === "CONTRACT_CHANGED",
  );
  exec.ws.close();
  await exec.done;
});

const WRITE_METHODS = ["updateAccount", "restoreCurrentFinances", "restorePlans", "restoreProgress", "restoreSettings"];

/** healthyHandler on a ProjectionLab 4 page (api.version absent), recording
 * every request frame. `onWrite` may answer a write instead. */
function recordingV4Handler(frames, onWrite) {
  return (frame) => {
    frames.push(frame);
    if (frame.method === "apiVersion") return { ok: true, result: null };
    if (onWrite && WRITE_METHODS.includes(frame.method)) return onWrite(frame);
    return healthyHandler(frame);
  };
}

test("each write carries the checked API version to an executor that honors it", async () => {
  const frames = [];
  const exec = connectExecutor({
    hello: { features: ["expectApiVersion"] },
    handler: recordingV4Handler(frames),
  });
  await exec.ready;
  await bridge.updateAccount("a", { balance: 1 }, undefined, "v4");
  await bridge.restorePlansIfUnchanged([], [], "v4");
  await bridge.restoreCurrentFinances({}, "v4");
  await bridge.restoreProgress({}, "v4");
  await bridge.restoreSettings({}, "v4");
  const writes = frames.filter((f) => WRITE_METHODS.includes(f.method));
  assert.deepEqual(writes.map((f) => f.method), ["updateAccount", "restorePlans", "restoreCurrentFinances", "restoreProgress", "restoreSettings"]);
  for (const f of writes) {
    assert.equal(Object.hasOwn(f, "expectApiVersion"), true, f.method);
    assert.equal(f.expectApiVersion, null, f.method);
  }
  // Reads, including the conflict check's export, are never guarded.
  for (const f of frames.filter((f) => !WRITE_METHODS.includes(f.method))) {
    assert.equal(Object.hasOwn(f, "expectApiVersion"), false, f.method);
  }
  exec.ws.close();
  await exec.done;
});

test("an executor that does not list the feature gets no expectApiVersion", async () => {
  const frames = [];
  const exec = connectExecutor({ handler: recordingV4Handler(frames) });
  await exec.ready;
  await bridge.updateAccount("a", { balance: 1 }, undefined, "v4");
  await bridge.restorePlansIfUnchanged([], [], "v4");
  const writes = frames.filter((f) => WRITE_METHODS.includes(f.method));
  assert.equal(writes.length, 2);
  for (const f of writes) assert.equal(Object.hasOwn(f, "expectApiVersion"), false, f.method);
  exec.ws.close();
  await exec.done;
});

test("a write the page refuses with CONTRACT_CHANGED rejects with that code", async () => {
  const frames = [];
  const exec = connectExecutor({
    hello: { features: ["expectApiVersion"] },
    handler: recordingV4Handler(frames, () => ({
      ok: false,
      error: { code: "CONTRACT_CHANGED", message: "Plugin API version is 2, not the null the server checked" },
    })),
  });
  await exec.ready;
  for (const write of [() => bridge.updateAccount("a", { balance: 1 }, undefined, "v4"), () => bridge.restorePlansIfUnchanged([], [], "v4")]) {
    await assert.rejects(write(), (err) => {
      assert.equal(err.code, "CONTRACT_CHANGED");
      assert.match(err.suggestion, /Nothing was written/);
      return true;
    });
  }
  exec.ws.close();
  await exec.done;
});

test("a write prepared from ProjectionLab 5 data is refused on a ProjectionLab 4 page", async () => {
  const frames = [];
  const exec = connectExecutor({ handler: recordingV4Handler(frames) });
  await exec.ready;
  const writes = [
    () => bridge.updateAccount("a", { balance: 1 }, undefined, "v5"),
    () => bridge.restoreCurrentFinances({}, "v5"),
    () => bridge.restorePlans([], "v5"),
    () => bridge.restorePlansIfUnchanged([], [], "v5"),
    () => bridge.restoreProgress({}, "v5"),
    () => bridge.restoreSettings({}, "v5"),
  ];
  for (const write of writes) {
    await assert.rejects(write(), (err) => {
      assert.equal(err.code, "CONTRACT_CHANGED");
      assert.match(err.message, /prepared from ProjectionLab 5 data/);
      assert.match(err.suggestion, /Nothing was written/);
      return true;
    });
  }
  // Nothing past the contract check reached the page.
  assert.deepEqual(frames.map((f) => f.method).filter((m) => m !== "apiVersion"), []);
  exec.ws.close();
  await exec.done;
});

test("a plan write is refused when its in-entry re-read has the other layout", async () => {
  // The contract check answers ProjectionLab 4, but the export the write
  // re-reads comes from a ProjectionLab 5 tab.
  const frames = [];
  const exec = connectExecutor({
    handler: (frame) =>
      frame.method === "exportData"
        ? (frames.push(frame), { ok: true, result: { schema: 1, documents: { plans: [] } } })
        : recordingV4Handler(frames)(frame),
  });
  await exec.ready;
  await assert.rejects(bridge.restorePlansIfUnchanged([], [], "v4"), (err) => {
    assert.equal(err.code, "CONTRACT_CHANGED");
    assert.match(err.message, /prepared from ProjectionLab 4 data/);
    return true;
  });
  assert.deepEqual(frames.filter((f) => WRITE_METHODS.includes(f.method)), []);
  exec.ws.close();
  await exec.done;
});

test("an executor without apiVersion falls back to the member list", async () => {
  // healthyHandler rejects apiVersion and lists no version member: contract 1.
  const exec = connectExecutor({ handler: healthyHandler });
  await exec.ready;
  assert.equal(await bridge.apiContract(), 1);
  exec.ws.close();
  await exec.done;

  // An old executor on a page whose API has a version member is refused.
  const outdated = connectExecutor({
    handler: (frame) =>
      frame.method === "describeApi"
        ? { ok: true, result: { exportData: "function(1 args)", version: "number" } }
        : healthyHandler(frame),
  });
  await outdated.ready;
  await assert.rejects(bridge.restorePlans([], "v4"), (err) => {
    assert.equal(err.code, "EXECUTOR_OUTDATED");
    return true;
  });
  outdated.ws.close();
  await outdated.done;
});

test("an unknown api.version refuses writes", async () => {
  const seen = [];
  const exec = connectExecutor({
    handler: (frame) => {
      seen.push(frame.method);
      return frame.method === "apiVersion" ? { ok: true, result: 3 } : healthyHandler(frame);
    },
  });
  await exec.ready;
  await assert.rejects(bridge.restoreSettings({}, "v4"), (err) => {
    assert.equal(err.code, "UNSUPPORTED_API_VERSION");
    return true;
  });
  assert.deepEqual(seen, ["apiVersion"]);
  exec.ws.close();
  await exec.done;
});

test("close() shuts down cleanly and further calls fail fast", async () => {
  await bridge.close();
  await assert.rejects(bridge.describePluginApi(), (err) => {
    assert.equal(err.code, "EXTENSION_NOT_CONNECTED");
    return true;
  });
});
