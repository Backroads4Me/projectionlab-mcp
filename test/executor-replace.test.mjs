// When a new executor replaces the old one, the old executor's state goes
// with it: in-flight requests reject at once instead of hanging until the
// timeout, and the export cache from the previous browser is not served.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();
const TOKEN = "replace-test-token";

const home = mkdtempSync(join(tmpdir(), "plmcp-replace-home-"));
process.env.HOME = home;
process.env.PL_API_KEY = "test-api-key";
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = TOKEN;
process.env.PL_SNAPSHOT_DIR = join(home, "snapshots");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { PROTOCOL_VERSION } = await import("../dist/types/wire.js");

const bridge = new ExtensionBridge();
await new Promise((r) => setTimeout(r, 200));
after(() => bridge.close());

/**
 * A fake executor over a real WebSocket. It answers pings; exportData
 * replies with `payload`, or is ignored when payload is "ignore".
 */
function executor(label, payload) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const requests = [];
  let acked;
  const ackedPromise = new Promise((r) => (acked = r));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token: TOKEN,
        protocolVersion: PROTOCOL_VERSION,
        executor: label,
      }),
    ),
  );
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === "helloAck") acked();
    else if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    else if (frame.type === "request") {
      requests.push(frame);
      if (frame.method === "exportData" && payload !== "ignore") {
        ws.send(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: true,
            result: structuredClone(payload),
          }),
        );
      }
    }
  });
  ws.on("error", () => {});
  return {
    ws,
    requests,
    acked: ackedPromise,
    sawRequest(method) {
      return requests.some((f) => f.method === method);
    },
  };
}

async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a request on the replaced executor rejects promptly with EXTENSION_NOT_CONNECTED", async () => {
  const hanging = executor("fake/hanging", "ignore");
  await hanging.acked;

  const start = Date.now();
  const inFlight = bridge.exportData({ fresh: true });
  // Attach the outcome handler before the replacement lands, so the
  // expected rejection is observed, not reported as unhandled.
  const outcome = inFlight.then(
    () => ({ status: "resolved" }),
    (err) => ({ status: "rejected", err }),
  );
  await waitFor(() => hanging.sawRequest("exportData"), "the request to reach executor 1");

  const replacement = executor("fake/replacement", { marker: "second" });
  await replacement.acked;

  const settled = await Promise.race([
    outcome,
    new Promise((r) => setTimeout(() => r({ status: "timeout" }), 10_000)),
  ]);
  assert.equal(settled.status, "rejected");
  assert.equal(settled.err.code, "EXTENSION_NOT_CONNECTED");
  assert.match(settled.err.message, /executor was replaced/);
  assert.ok(Date.now() - start < 10_000, "must reject promptly, not at the 60s timeout");

  // New requests run against the surviving executor.
  const next = await bridge.exportData({ fresh: true });
  assert.equal(next.marker, "second");
  replacement.ws.close();
});

test("a replaced executor's cached export is not served by the new one", async () => {
  const first = executor("fake/first", { marker: "X" });
  await first.acked;
  assert.equal((await bridge.exportData({ fresh: true })).marker, "X");
  // The cache holds X now; a plain read is served from it.
  assert.equal((await bridge.exportData()).marker, "X");

  const second = executor("fake/second", { marker: "Y" });
  await second.acked;

  assert.equal(
    (await bridge.exportData()).marker,
    "Y",
    "the previous browser's cached export must not survive the replacement",
  );
  second.ws.close();
});
