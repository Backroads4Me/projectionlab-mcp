// Runs the generated Tier 0 bootstrap snippet in a vm sandbox that fakes a
// ProjectionLab tab (window + projectionlabPluginAPI + WebSocket), against a
// real ExtensionBridge. Verifies the snippet is a working executor.
//
// Run: node --test test/bootstrap.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();

process.env.PL_API_KEY = "test-api-key";
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = "test-token";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { buildBootstrapSnippet } = await import("../dist/bootstrap.js");

const calls = [];
const pluginApi = {
  exportData: async ({ key }) => {
    if (key !== "test-api-key") throw new Error("invalid key");
    return { plans: [], today: { accounts: [] }, exportedAt: 1 };
  },
  updateAccount: async (id, data, opts) => {
    calls.push(["updateAccount", id, data, opts]);
  },
};

test("bootstrap snippet acts as a full executor", async () => {
  const bridge = new ExtensionBridge();
  await new Promise((r) => setTimeout(r, 100));

  const sandbox = {
    window: { projectionlabPluginAPI: pluginApi },
    WebSocket,
    console: { log: () => {} },
    // unref'd so the snippet's reconnect loop can't hold the process open
    // after the bridge shuts down at the end of the test
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(bridge.bootstrapSnippet(), sandbox);

  // Wait for the snippet to authenticate
  for (let i = 0; i < 50; i++) {
    const status = await bridge.checkConnection();
    if (status.browser) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const status = await bridge.checkConnection();
  assert.equal(status.browser, true);
  assert.equal(status.apiAvailable, true);
  // validateApiKey is absent from the fake API object; the snippet reports
  // "method unavailable" and the bridge records a key error - matching how
  // older PL builds behave. Not asserting apiKeyValid here.

  const described = await bridge.describePluginApi();
  assert.equal(described.exportData, "function(1 args)");
  assert.equal(described.updateAccount, "function(3 args)");

  const data = await bridge.exportData({ fresh: true });
  assert.deepEqual(data.plans, []);

  await bridge.updateAccount("acct-1", { balance: 42 }, true);
  // JSON round-trip: the snippet parses frames inside the vm realm, so its
  // objects have a foreign prototype that deepEqual would reject.
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), [
    "updateAccount",
    "acct-1",
    { balance: 42 },
    { key: "test-api-key", force: "true" },
  ]);

  // Second install in the same tab is a no-op
  vm.runInContext(bridge.bootstrapSnippet(), sandbox);
  assert.equal(sandbox.window.__plmcpBootstrap, true);

  // Stub out WebSocket so the snippet's reconnect loop can't create live
  // sockets after shutdown and hold the process open.
  sandbox.WebSocket = class {
    send() {}
    close() {}
  };
  await bridge.close();
});

test("bootstrap snippet refuses a method outside the wire protocol", async () => {
  // A stand-in server, so the test can send a request the bridge never would.
  const port = await freePort();
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  await new Promise((resolve) => wss.once("listening", resolve));
  let called = false;
  const sandbox = {
    window: { projectionlabPluginAPI: { wipeEverything: () => { called = true; } } },
    WebSocket,
    console: { log: () => {} },
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout,
  };
  const response = new Promise((resolve) => {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "hello") {
          ws.send(JSON.stringify({ type: "helloAck", protocolVersion: frame.protocolVersion }));
          ws.send(JSON.stringify({ type: "request", id: "1", method: "wipeEverything", params: [] }));
        } else if (frame.type === "response") {
          resolve(frame);
        }
      });
    });
  });
  vm.createContext(sandbox);
  vm.runInContext(buildBootstrapSnippet(port, "test-token"), sandbox);

  const frame = await response;
  assert.equal(frame.ok, false);
  assert.equal(frame.error.code, "UNKNOWN");
  assert.match(frame.error.message, /Not a wire protocol method: wipeEverything/);
  assert.equal(called, false);

  sandbox.WebSocket = class {
    send() {}
    close() {}
  };
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
});
