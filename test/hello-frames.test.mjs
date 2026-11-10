// Frames that are valid JSON but not objects (`null`, `42`) are refused
// without ending the process, and a blank PL_WS_TOKEN never authenticates.
//
// Run: npm run build && node --test test/hello-frames.test.mjs

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();

const home = mkdtempSync(join(tmpdir(), "plmcp-hello-home-"));
process.env.HOME = home;
process.env.PL_API_KEY = "test-api-key";
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = "  "; // present but blank
process.env.PL_SNAPSHOT_DIR = join(home, "snapshots");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { CLOSE_CODES, PROTOCOL_VERSION } = await import("../dist/types/wire.js");

const bridge = new ExtensionBridge();
await new Promise((r) => setTimeout(r, 200));
after(() => bridge.close());

const generatedToken = () =>
  readFileSync(join(home, ".projectionlab-mcp", "ws-token"), "utf8").trim();

const hello = (token) =>
  JSON.stringify({ type: "hello", token, protocolVersion: PROTOCOL_VERSION, executor: "fake/1.0" });

/** Opens a socket, sends `first`, and resolves with the close code or "acked". */
function firstFrameOutcome(first) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("open", () => ws.send(first));
    ws.on("message", (raw) => {
      if (JSON.parse(String(raw)).type === "helloAck") {
        ws.close();
        resolve("acked");
      }
    });
    ws.on("close", (code) => resolve(code));
    ws.on("error", reject);
  });
}

test("a blank PL_WS_TOKEN generates a token instead of accepting an empty one", async () => {
  assert.match(generatedToken(), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(await firstFrameOutcome(hello("")), CLOSE_CODES.AUTH_FAILED);
  assert.equal(await firstFrameOutcome(hello("  ")), CLOSE_CODES.AUTH_FAILED);
  assert.equal(await firstFrameOutcome(hello(generatedToken())), "acked");
});

test("a non-object hello is refused as malformed", async () => {
  for (const frame of ["null", "42", '"hello"']) {
    assert.equal(await firstFrameOutcome(frame), CLOSE_CODES.AUTH_FAILED, frame);
  }
});

test("a non-object frame after the hello is dropped and the executor stays connected", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(hello(generatedToken())));
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "helloAck") resolve();
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (frame.type === "request") {
        ws.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result: true }));
      }
    });
    ws.on("error", reject);
  });
  try {
    ws.send("null");
    ws.send("42");
    const status = await bridge.checkConnection();
    assert.equal(status.browser, true);
    assert.equal(status.apiKeyValid, true);
  } finally {
    ws.close();
  }
});
