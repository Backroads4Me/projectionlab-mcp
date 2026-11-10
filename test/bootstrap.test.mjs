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
    crypto: { randomUUID: () => "sandbox-instance-id" },
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
    crypto: { randomUUID: () => "sandbox-instance-id" },
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

test("the snippet classifies key errors by whole-number 401/403 only", async () => {
  const port = await freePort();
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  await new Promise((resolve) => wss.once("listening", resolve));
  const responses = new Map();
  const responsesDone = new Promise((resolve) => {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "hello") {
          ws.send(JSON.stringify({ type: "helloAck", protocolVersion: frame.protocolVersion }));
          ws.send(JSON.stringify({ type: "request", id: "bare-401", method: "exportData", params: [{ key: "status 401 from the api" }] }));
          ws.send(JSON.stringify({ type: "request", id: "digits", method: "exportData", params: [{ key: "your balance is 14010 and 40300" }] }));
        } else if (frame.type === "response") {
          responses.set(frame.id, frame);
          if (responses.size === 2) resolve();
        }
      });
    });
  });
  // A snippet that stops answering fails the test instead of hanging it.
  const done = Promise.race([
    responsesDone,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error("snippet never answered")), 10000);
      t.unref();
    }),
  ]);
  const sandbox = {
    window: {
      projectionlabPluginAPI: {
        exportData: async ({ key }) => {
          throw new Error(key);
        },
      },
    },
    WebSocket,
    crypto: { randomUUID: () => "sandbox-instance-id" },
    console: { log: () => {} },
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(buildBootstrapSnippet(port, "test-token"), sandbox);

  try {
    await done;
    assert.equal(responses.get("bare-401").ok, false);
    assert.equal(responses.get("bare-401").error.code, "API_KEY_INVALID");
    assert.equal(responses.get("digits").ok, false);
    assert.equal(responses.get("digits").error.code, "UNKNOWN");
  } finally {
    sandbox.WebSocket = class {
      send() {}
      close() {}
    };
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("the snippet and page-main carry one identical key-error regex", async () => {
  // The two executors must classify errors the same way; bootstrap.ts says
  // its executor logic stays in sync with extension/src/page-main.js.
  const { readFile } = await import("node:fs/promises");
  const pageMain = await readFile(
    new URL("../extension/src/page-main.js", import.meta.url),
    "utf8",
  );
  const literal = /\/api\.\?key\|[^/\n]*\/i/;
  const snippetCopy = buildBootstrapSnippet(1, "t").match(literal)[0];
  const pageMainCopy = pageMain.match(literal)[0];
  assert.equal(snippetCopy, pageMainCopy);
  assert.match(snippetCopy, /\\b401\\b\|\\b403\\b/);
});

/**
 * Runs the snippet against a stand-in server that acks the hello and then
 * closes with closeCode. Collects the hellos sent, the snippet's console
 * lines, and the reconnect delays it scheduled.
 */
async function snippetCloseScenario(closeCode) {
  const port = await freePort();
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  await new Promise((resolve) => wss.once("listening", resolve));
  const hellos = [];
  const logs = [];
  const retryDelays = [];
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "hello") {
        hellos.push(frame);
        ws.send(JSON.stringify({ type: "helloAck", protocolVersion: frame.protocolVersion }));
        ws.close(closeCode, "scenario");
      }
    });
  });
  const sandbox = {
    window: {},
    WebSocket,
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    console: { log: (_prefix, m) => logs.push(m) },
    setTimeout: (fn, ms) => {
      retryDelays.push(ms);
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(buildBootstrapSnippet(port, "test-token"), sandbox);
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 300);
    t.unref();
  });
  return { hellos, logs, retryDelays, sandbox, wss };
}

async function cleanupScenario(sandbox, wss) {
  sandbox.WebSocket = class {
    send() {}
    close() {}
  };
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
}

test("the snippet sends a stable instance id and never asks for takeover", async () => {
  const s = await snippetCloseScenario(4004);
  try {
    assert.ok(s.hellos.length >= 1);
    assert.equal(s.hellos[0].instanceId, "11111111-2222-3333-4444-555555555555");
    assert.equal("takeover" in s.hellos[0], false);
  } finally {
    await cleanupScenario(s.sandbox, s.wss);
  }
});

test("on 4004 the snippet waits 30 seconds and stays installed", async () => {
  const s = await snippetCloseScenario(4004);
  try {
    assert.match(s.logs.join("\n"), /another executor is connected/);
    assert.equal(s.retryDelays[0], 30000);
    assert.equal(s.sandbox.window.__plmcpBootstrap, true);
  } finally {
    await cleanupScenario(s.sandbox, s.wss);
  }
});

test("on 4003 the snippet logs the takeover and waits 30 seconds", async () => {
  const s = await snippetCloseScenario(4003);
  try {
    assert.match(s.logs.join("\n"), /took over the connection/);
    assert.equal(s.retryDelays[0], 30000);
    assert.equal(s.sandbox.window.__plmcpBootstrap, true);
  } finally {
    await cleanupScenario(s.sandbox, s.wss);
  }
});

test("on 4001 the snippet stops and clears the installed flag", async () => {
  const s = await snippetCloseScenario(4001);
  try {
    assert.match(s.logs.join("\n"), /stopped:/);
    assert.deepEqual(s.retryDelays, []);
    assert.equal(s.sandbox.window.__plmcpBootstrap, false);
  } finally {
    await cleanupScenario(s.sandbox, s.wss);
  }
});
