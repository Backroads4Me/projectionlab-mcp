// The incumbent keeps the connection: a second authenticated executor is
// refused with 4004 BUSY and takes over only by request (takeover: true) or
// by repeating its own instance id. Refusal changes nothing else: the cache
// stays, in-flight requests keep their answers.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();
const TOKEN = "busy-test-token";

const home = mkdtempSync(join(tmpdir(), "plmcp-busy-home-"));
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
 * replies with { marker: label } unless `payload` says otherwise; `hang`
 * holds every answer until release() is called. `extra` adds hello fields.
 * closed resolves with the server's close code.
 */
function executor(label, { payload, instanceId, takeover, token = TOKEN, hang = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const requests = [];
  let acked;
  const ackedPromise = new Promise((r) => (acked = r));
  let closed;
  const closedPromise = new Promise((r) => (closed = r));
  let releaseGate;
  const gate = new Promise((r) => (releaseGate = r));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token,
        protocolVersion: PROTOCOL_VERSION,
        executor: label,
        ...(instanceId === undefined ? {} : { instanceId }),
        ...(takeover === undefined ? {} : { takeover }),
      }),
    ),
  );
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === "helloAck") acked();
    else if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    else if (frame.type === "request") {
      requests.push(frame);
      const body = payload === undefined ? { marker: label } : payload;
      const respond = () =>
        ws.send(
          JSON.stringify({ type: "response", id: frame.id, ok: true, result: structuredClone(body) }),
        );
      if (hang) void gate.then(respond);
      else respond();
    }
  });
  ws.on("close", (code) => closed(code));
  ws.on("error", () => {});
  // Refused executors never see a helloAck; their guard must not surface as
  // an unhandled rejection after the test that checked the close code ends.
  void ackedPromise.catch(() => {});
  return {
    ws,
    requests,
    acked: withGuard(ackedPromise, `executor ${label} was never acknowledged`),
    closed: withGuard(closedPromise, `executor ${label} was never closed`),
    release: () => releaseGate(),
    sawRequest(method) {
      return requests.some((f) => f.method === method);
    },
  };
}

function withGuard(promise, what, ms = 3000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
      t.unref();
    }),
  ]);
}

async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a second executor with another instance id gets 4004 and changes nothing", async () => {
  const a = executor("fake/busy-a", { instanceId: "inst-a", hang: true });
  await a.acked;
  const inFlight = bridge.exportData({ fresh: true });
  await waitFor(() => a.sawRequest("exportData"), "the request to reach executor a");

  const b = executor("fake/busy-b", { instanceId: "inst-b" });
  assert.equal(await b.closed, 4004);
  assert.deepEqual(b.requests, []);

  // The incumbent is untouched: the in-flight request still completes,
  // and a plain read is served from the cache it just filled.
  a.release();
  assert.equal((await inFlight).marker, "fake/busy-a");
  const requestsBefore = a.requests.length;
  assert.equal((await bridge.exportData()).marker, "fake/busy-a");
  assert.equal(a.requests.length, requestsBefore, "cache must survive the refusal");

  a.ws.close();
});

test("a second executor without an instance id gets 4004", async () => {
  const a = executor("fake/noid-a", { instanceId: "inst-noid-a" });
  await a.acked;
  // The 1.1.0 extension and older snippets send no instance id.
  const b = executor("fake/noid-b");
  assert.equal(await b.closed, 4004);
  assert.equal((await bridge.exportData({ fresh: true })).marker, "fake/noid-a");
  a.ws.close();
});

test("takeover: true replaces the incumbent, rejecting pending requests and clearing the cache", async () => {
  const a = executor("fake/ta-a", { instanceId: "inst-ta-a", hang: true });
  await a.acked;
  const inFlight = bridge.exportData({ fresh: true });
  // Attach the outcome handler before the replacement lands, so the
  // expected rejection is observed, not reported as unhandled.
  const settledPromise = inFlight.then(
    () => ({ status: "resolved" }),
    (err) => ({ status: "rejected", err }),
  );
  await waitFor(() => a.sawRequest("exportData"), "the request to reach executor a");

  const b = executor("fake/ta-b", { instanceId: "inst-ta-b", takeover: true });
  await b.acked;
  assert.equal(await a.closed, 4003);
  const settled = await settledPromise;
  assert.equal(settled.status, "rejected");
  assert.equal(settled.err.code, "EXTENSION_NOT_CONNECTED");
  assert.match(settled.err.message, /executor was replaced/);

  // The cache cleared with the old executor: a plain read goes to b.
  assert.equal((await bridge.exportData()).marker, "fake/ta-b");
  b.ws.close();
});

test("a hello with the incumbent's instance id replaces its own stale connection", async () => {
  const stale = executor("fake/self-a", { instanceId: "inst-self" });
  await stale.acked;
  const fresh = executor("fake/self-b", { instanceId: "inst-self" });
  await fresh.acked;
  assert.equal(await stale.closed, 4003);
  assert.equal((await bridge.exportData({ fresh: true })).marker, "fake/self-b");
  fresh.ws.close();
});

test("an executor refused with BUSY connects after the incumbent disconnects", async () => {
  const a = executor("fake/recover-a", { instanceId: "inst-rec-a" });
  await a.acked;
  const b = executor("fake/recover-b", { instanceId: "inst-rec-b" });
  assert.equal(await b.closed, 4004);

  a.ws.close();
  await waitFor(() => a.ws.readyState === WebSocket.CLOSED, "the incumbent close to finish");
  await new Promise((r) => setTimeout(r, 100));
  // b's next attempt (the extension retries on its slow schedule) connects.
  const retry = executor("fake/recover-b2", { instanceId: "inst-rec-b" });
  await retry.acked;
  assert.equal((await bridge.exportData({ fresh: true })).marker, "fake/recover-b2");
  retry.ws.close();
});

test("a wrong-token hello with takeover gets 4001 and leaves the incumbent alone", async () => {
  const a = executor("fake/auth-a", { instanceId: "inst-auth-a" });
  await a.acked;
  const bad = executor("fake/auth-bad", { instanceId: "inst-auth-a", takeover: true, token: "wrong-token" });
  assert.equal(await bad.closed, 4001);
  assert.equal((await bridge.exportData({ fresh: true })).marker, "fake/auth-a");
  a.ws.close();
});

test("takeover must be exactly true and instanceId at most 64 characters", async () => {
  const a = executor("fake/strict-a", { instanceId: "inst-strict-a" });
  await a.acked;

  // A string "true" is not a takeover request, so this is a plain second
  // executor and gets BUSY.
  const str = executor("fake/strict-str", { instanceId: "inst-strict-b", takeover: "true" });
  assert.equal(await str.closed, 4004);

  // An oversized instance id counts as absent, so it cannot match the
  // incumbent's id and gets BUSY like any other stranger.
  const long = executor("fake/strict-long", { instanceId: "x".repeat(65) });
  assert.equal(await long.closed, 4004);

  // 64 characters is inside the accepted range: the same id replaces itself.
  a.ws.close();
  await waitFor(() => a.ws.readyState === WebSocket.CLOSED, "the incumbent close to finish");
  await new Promise((r) => setTimeout(r, 100));
  const id64 = "y".repeat(64);
  const first = executor("fake/strict-64a", { instanceId: id64 });
  await first.acked;
  const again = executor("fake/strict-64b", { instanceId: id64 });
  await again.acked;
  assert.equal(await first.closed, 4003);
  assert.equal((await bridge.exportData({ fresh: true })).marker, "fake/strict-64b");
  again.ws.close();
});
