// Page origins allowed to connect the bootstrap snippet: both ProjectionLab
// app origins (main and Early Access) plus the one PL_APP_URL names.
// Any other page origin is refused before its hello is read.
//
// Run: npm run build && node --test test/origin.test.mjs

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();
const TOKEN = "origin-token";

const home = mkdtempSync(join(tmpdir(), "plmcp-origin-home-"));
process.env.HOME = home;
process.env.PL_API_KEY = "test-api-key";
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = TOKEN;
process.env.PL_APP_URL = "https://pl.example:8443/app";
process.env.PL_SNAPSHOT_DIR = join(home, "snapshots");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { CLOSE_CODES, PROTOCOL_VERSION } = await import("../dist/types/wire.js");

const bridge = new ExtensionBridge();
await new Promise((r) => setTimeout(r, 200));
after(() => bridge.close());

/** Connects with `origin`, sends a valid hello, and resolves with "acked" or the close code. */
function helloOutcome(origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: origin } });
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "hello", token: TOKEN, protocolVersion: PROTOCOL_VERSION, executor: "fake/1.0" })),
    );
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

test("both ProjectionLab app origins and the PL_APP_URL origin may connect", async () => {
  for (const origin of ["https://app.projectionlab.com", "https://ea.projectionlab.com", "https://pl.example:8443"]) {
    assert.equal(await helloOutcome(origin), "acked", origin);
  }
});

test("other page origins are refused", async () => {
  for (const origin of ["https://evil.example", "http://ea.projectionlab.com", "https://projectionlab.com"]) {
    assert.equal(await helloOutcome(origin), CLOSE_CODES.AUTH_FAILED, origin);
  }
});
