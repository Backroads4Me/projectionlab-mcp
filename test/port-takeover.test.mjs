// A second server instance whose WebSocket port is held by another instance
// reports that state, then takes the port over once the first exits. Also
// covers the missing-key path, since this process runs without PL_API_KEY.
//
// Run: npm run build && node --test test/port-takeover.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();
const TOKEN = "takeover-token";

const home = mkdtempSync(join(tmpdir(), "plmcp-home-"));
process.env.HOME = home;
process.env.PL_API_KEY = ""; // present but empty: dotenv files cannot fill it
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = TOKEN;
process.env.PL_SNAPSHOT_DIR = join(home, "snapshots");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { PROTOCOL_VERSION } = await import("../dist/types/wire.js");

function connectExecutor() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", token: TOKEN, protocolVersion: PROTOCOL_VERSION, executor: "fake/1.0" }));
    });
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "helloAck") resolve(ws);
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (frame.type === "request") ws.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result: true }));
    });
    ws.on("error", reject);
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test("second instance waits for the port and takes over when the first exits", async () => {
  const first = new ExtensionBridge();
  await new Promise((r) => setTimeout(r, 200));
  const second = new ExtensionBridge();
  await new Promise((r) => setTimeout(r, 200));

  const waiting = await second.checkConnection();
  assert.equal(waiting.browser, false);
  assert.ok(
    waiting.errors.some((e) => e.includes("held by another projectionlab-mcp instance")),
    `expected port-held message, got ${JSON.stringify(waiting.errors)}`,
  );

  await first.close();
  const tookOver = await waitFor(async () => {
    try {
      const ws = await connectExecutor();
      ws.close();
      return true;
    } catch {
      return false;
    }
  }, 8_000);
  assert.ok(tookOver, "second instance never took over the port");

  const ws = await connectExecutor();
  await new Promise((r) => setTimeout(r, 100));
  const status = await second.checkConnection();
  assert.equal(status.browser, true);
  assert.equal(status.apiKeyValid, false);
  assert.ok(status.errors.some((e) => e.startsWith("API_KEY_MISSING")), JSON.stringify(status.errors));

  await assert.rejects(second.exportData({ fresh: true }), (err) => err.code === "API_KEY_MISSING");

  ws.close();
  await second.close();
});
