// Writes reach ProjectionLab only while the connected executor reports its
// "Enable agent plan edits" switch on. A real ExtensionBridge talks to a fake
// executor over WebSocket; the executor records every request it receives, so
// a refused write is shown to never leave the server.
//
// Run: npm run build && node --test test/edit-access.test.mjs

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();
const TOKEN = "test-token";
const SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-edit-access-")), "snapshots");

process.env.HOME = mkdtempSync(join(tmpdir(), "plmcp-edit-access-home-"));
process.env.PL_API_KEY = "test-api-key";
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = TOKEN;
process.env.PL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { PROTOCOL_VERSION } = await import("../dist/types/wire.js");
const { SnapshotManager } = await import("../dist/snapshot.js");
const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { registerUpdateAccountTool } = await import("../dist/tools/updateAccount.js");

const bridge = new ExtensionBridge();
await new Promise((r) => setTimeout(r, 200));
after(() => bridge.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake executor. `hello` is merged into the hello frame, so leaving out
 * allowEdits plays an executor without the switch. `refuseWrites` answers
 * writes the way the extension does while its switch is off.
 */
async function connect({ hello = {}, refuseWrites = false } = {}) {
  const methods = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("open", () =>
    ws.send(JSON.stringify({ type: "hello", token: TOKEN, protocolVersion: PROTOCOL_VERSION, executor: "fake/1.0", ...hello })),
  );
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    if (frame.type !== "request") return;
    methods.push(frame.method);
    const read = ["exportData", "validateApiKey", "describeApi", "waitForApi"].includes(frame.method);
    const reply = !read && refuseWrites
      ? { ok: false, error: { code: "EDITS_DISABLED", message: "Agent plan edits are turned off" } }
      : { ok: true, result: frame.method === "exportData" ? { plans: [], today: { accounts: [{ id: "a1", name: "Cash", balance: 1 }] }, settings: {} } : true };
    ws.send(JSON.stringify({ type: "response", id: frame.id, ...reply }));
  });
  await new Promise((resolve, reject) => {
    ws.on("message", (raw) => {
      if (JSON.parse(String(raw)).type === "helloAck") resolve();
    });
    ws.on("close", () => reject(new Error("closed before helloAck")));
  });
  const close = async () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((r) => ws.once("close", r));
      ws.close();
      await closed;
    }
    await sleep(50);
  };
  const settings = async (allowEdits) => {
    ws.send(JSON.stringify({ type: "settings", allowEdits }));
    await sleep(50);
  };
  return { methods, close, settings };
}

const writes = (methods) => methods.filter((m) => m !== "exportData" && m !== "waitForApi" && m !== "validateApiKey");

test("an executor without the switch can read but never write", async () => {
  const exec = await connect();
  try {
    assert.equal(await bridge.editAccess(), "unsupported");
    assert.equal((await bridge.checkConnection()).writesEnabled, false);
    await bridge.exportData({ fresh: true });
    for (const write of [
      () => bridge.restorePlans([]),
      () => bridge.restorePlansIfUnchanged([], []),
      () => bridge.restoreCurrentFinances({}),
      () => bridge.restoreProgress({}),
      () => bridge.restoreSettings({}),
      () => bridge.updateAccount("a1", { balance: 2 }),
    ]) {
      await assert.rejects(write(), { code: "READ_ONLY_MODE", message: /no plan-edits switch/ });
    }
    assert.deepEqual(writes(exec.methods), []);
  } finally {
    await exec.close();
  }
});

test("the switch reported in the hello and in settings frames decides each write", async () => {
  const exec = await connect({ hello: { allowEdits: false } });
  try {
    assert.equal(await bridge.editAccess(), "disabled");
    await assert.rejects(bridge.restoreSettings({}), { code: "READ_ONLY_MODE", message: /turned off/ });
    assert.deepEqual(writes(exec.methods), []);

    await exec.settings(true);
    assert.equal(await bridge.editAccess(), "enabled");
    assert.equal((await bridge.checkConnection()).writesEnabled, true);
    await bridge.restoreSettings({});
    assert.deepEqual(writes(exec.methods), ["restoreSettings"]);

    await exec.settings(false);
    await assert.rejects(bridge.restoreSettings({}), { code: "READ_ONLY_MODE" });
    assert.deepEqual(writes(exec.methods), ["restoreSettings"]);
  } finally {
    await exec.close();
  }
});

test("a write the browser refuses maps to READ_ONLY_MODE and turns edits off", async () => {
  // The switch went off in the browser before its settings frame arrived.
  const exec = await connect({ hello: { allowEdits: true }, refuseWrites: true });
  try {
    await assert.rejects(bridge.restoreSettings({}), { code: "READ_ONLY_MODE", message: /turned off/ });
    assert.equal(await bridge.editAccess(), "disabled");
  } finally {
    await exec.close();
  }
});

test("a replacing executor brings its own switch state", async () => {
  const first = await connect({ hello: { allowEdits: true, instanceId: "same" } });
  assert.equal(await bridge.editAccess(), "enabled");
  // Same instance id on a new socket replaces the first one.
  const second = await connect({ hello: { instanceId: "same" } });
  try {
    assert.equal(await bridge.editAccess(), "unsupported");
  } finally {
    await second.close();
    await first.close();
  }
});

test("write tools refuse a dry run before reading or snapshotting while edits are off", async () => {
  const exec = await connect({ hello: { allowEdits: false } });
  try {
    const handlers = new Map();
    const server = { registerTool: (name, _definition, handler) => handlers.set(name, handler) };
    const snapshots = new SnapshotManager();
    registerRestoreTools(server, bridge, snapshots);
    registerUpdateAccountTool(server, bridge, snapshots);
    for (const [name, args] of [
      ["projectionlab_restore_settings", { settings: {}, confirm: false }],
      ["projectionlab_update_account", { accountId: "a1", data: { balance: 2 }, force: false, confirm: false }],
    ]) {
      const result = await handlers.get(name)(args);
      assert.equal(result.isError, true, name);
      assert.equal(JSON.parse(result.content[0].text).error, "READ_ONLY_MODE", name);
    }
    assert.deepEqual(exec.methods, [], "no read, preview or write reached the executor");
    let saved = [];
    try {
      saved = readdirSync(SNAPSHOT_DIR);
    } catch {
      // The directory is only created by the first snapshot.
    }
    assert.deepEqual(saved, []);
  } finally {
    await exec.close();
  }
});
