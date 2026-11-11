// Server instances share one WebSocket port. A waiting instance that gets an
// operation asks the holder to yield; the holder finishes its queued work,
// releases the port, and drops its executor with an ordinary close, so the
// executor reconnects to the new holder. Holders that cannot yield (older
// servers, other processes) leave the waiting instance with a clear message.
// A plan write keeps its conflict check and its write in one operation, so
// a hand-over never falls between them.
//
// Run: npm run build && node --test test/port-takeover.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();
const TOKEN = "takeover-token";

const home = mkdtempSync(join(tmpdir(), "plmcp-home-"));
process.env.HOME = home;
process.env.PL_API_KEY = "test-api-key";
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = TOKEN;
process.env.PL_SNAPSHOT_DIR = join(home, "snapshots");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { CLOSE_CODES, PROTOCOL_VERSION } = await import("../dist/types/wire.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake extension: connects, answers pings and requests, and after any close
 * other than 4001-4004 reconnects in `reconnectMs`, as the extension does
 * after an ordinary close. `closes` records every close code it saw. With
 * `hang`, exportData answers wait until release() is called. With `plans`,
 * it keeps that plans array: exportData returns it, restorePlans replaces it
 * and re-stamps each plan as ProjectionLab does, and every answer takes
 * `responseMs`. `plans()` reads the current array.
 */
function reconnectingExecutor({ reconnectMs = 300, hang = false, plans, responseMs = 0 } = {}) {
  const closes = [];
  let stamp = 1_000;
  let stopped = false;
  let socket;
  let releaseGate;
  let gate = hang ? new Promise((r) => (releaseGate = r)) : Promise.resolve();
  let onRequest = () => {};
  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    socket = ws;
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "hello", token: TOKEN, protocolVersion: PROTOCOL_VERSION, executor: "fake/1.0" })),
    );
    ws.on("message", async (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (frame.type === "request") {
        onRequest(frame);
        if (frame.method === "exportData") await gate;
        if (responseMs) await sleep(responseMs);
        let result = true;
        if (frame.method === "exportData") {
          result = plans ? { plans: structuredClone(plans) } : { marker: "data" };
        }
        if (frame.method === "restorePlans" && plans) {
          plans = structuredClone(frame.params[0]).map((p) => ({ ...p, lastUpdated: ++stamp }));
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result }));
        }
      }
    });
    ws.on("error", () => {});
    ws.on("close", (code) => {
      closes.push(code);
      if (code >= 4001 && code <= 4004) return;
      setTimeout(connect, reconnectMs);
    });
  };
  connect();
  return {
    closes,
    plans: () => plans,
    release: () => releaseGate?.(),
    requested: (cb) => (onRequest = cb),
    stop() {
      stopped = true;
      socket?.close();
    },
  };
}

/** Sends one frame on a fresh socket and resolves with the close code. */
function sendFirstFrame(frame, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers });
    ws.on("open", () => ws.send(JSON.stringify(frame)));
    ws.on("close", (code) => resolve(code));
    ws.on("error", reject);
  });
}

/** Returns `use(item)`, which registers a bridge (close) or an executor
 * (stop) to be shut down when the test ends, pass or fail, and returns it. */
function tracker(t) {
  const items = [];
  t.after(async () => {
    for (const item of items) item.stop?.();
    for (const item of items) await item.close?.();
  });
  return (item) => {
    items.push(item);
    return item;
  };
}

/** A raw socket that sends `frame` once open; `closed` resolves with the
 * close code. */
function rawSocket(frame) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  if (frame) ws.on("open", () => ws.send(JSON.stringify(frame)));
  ws.on("error", () => {});
  const closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  return { ws, closed };
}

/** A holder with an export in flight that stays unanswered until
 * executor.release(). */
async function holderWithExportInFlight(use) {
  const holder = use(await startHolder());
  const executor = use(reconnectingExecutor({ hang: true }));
  await sleep(300);
  let sent;
  const exportSent = new Promise((r) => (sent = r));
  executor.requested((frame) => frame.method === "exportData" && sent());
  const inFlight = holder.exportData({ fresh: true });
  await exportSent;
  return { holder, executor, inFlight };
}

async function startHolder() {
  const bridge = new ExtensionBridge();
  await sleep(200);
  return bridge;
}

test("a waiting instance takes the port over on its first operation, and the holder can take it back", async (t) => {
  const use = tracker(t);
  const first = use(await startHolder());
  // 2 seconds is the extension's first retry after an ordinary close.
  const executor = use(reconnectingExecutor({ reconnectMs: 2_000 }));
  await sleep(300);
  assert.equal((await first.checkConnection()).browser, true);

  const second = use(new ExtensionBridge());
  await sleep(200);
  const status = await second.checkConnection();
  assert.equal(status.browser, true, JSON.stringify(status.errors));
  assert.equal(status.apiKeyValid, true);
  assert.ok(
    executor.closes.includes(CLOSE_CODES.HANDED_OVER),
    `executor should see an ordinary close, saw ${JSON.stringify(executor.closes)}`,
  );

  const back = await first.checkConnection();
  assert.equal(back.browser, true, JSON.stringify(back.errors));
  const data = await first.exportData({ fresh: true });
  assert.deepEqual(data, { marker: "data" });

});

test("the holder finishes an operation already sent to the browser before it yields", async (t) => {
  const use = tracker(t);
  const first = use(await startHolder());
  const executor = use(reconnectingExecutor({ hang: true }));
  await sleep(300);
  let sent;
  const exportSent = new Promise((r) => (sent = r));
  executor.requested((frame) => frame.method === "exportData" && sent());
  const inFlight = first.exportData({ fresh: true });
  await exportSent;

  const second = use(new ExtensionBridge());
  await sleep(200);
  let secondDone = false;
  const secondStatus = second.checkConnection().then((s) => {
    secondDone = true;
    return s;
  });
  await sleep(500);
  assert.equal(secondDone, false, "the holder yielded while a request was in flight");

  executor.release();
  assert.deepEqual(await inFlight, { marker: "data" });
  const status = await secondStatus;
  assert.equal(status.browser, true, JSON.stringify(status.errors));

});

test("an operation the holder starts right after yielding takes the port back without failing either side", async (t) => {
  const use = tracker(t);
  const first = use(await startHolder());
  const executor = use(reconnectingExecutor());
  await sleep(300);
  const second = use(new ExtensionBridge());
  await sleep(200);

  // The second's yield is queued behind the first's in-flight export, and
  // the first's next export is queued right behind the yield.
  const firstExport = first.exportData({ fresh: true });
  const secondStatus = second.checkConnection();
  await sleep(50);
  const firstAgain = first.exportData({ fresh: true });

  assert.deepEqual(await firstExport, { marker: "data" });
  const status = await secondStatus;
  assert.equal(status.browser, true, JSON.stringify(status.errors));
  assert.deepEqual(await firstAgain, { marker: "data" });

});

test("with three instances, both waiting instances run their operation", async (t) => {
  const use = tracker(t);
  const a = use(await startHolder());
  const executor = use(reconnectingExecutor());
  await sleep(300);
  const b = use(new ExtensionBridge());
  const c = use(new ExtensionBridge());
  await sleep(200);

  const [sb, sc] = await Promise.all([b.checkConnection(), c.checkConnection()]);
  // The one that loses the bind after the holder yields asks the winner.
  assert.equal(sb.browser, true, JSON.stringify(sb.errors));
  assert.equal(sc.browser, true, JSON.stringify(sc.errors));
  const sa = await a.checkConnection();
  assert.equal(sa.browser, true, JSON.stringify(sa.errors));

});

test("a yield frame with an Origin header or a wrong token is refused", async (t) => {
  const use = tracker(t);
  const holder = use(await startHolder());
  const withOrigin = await sendFirstFrame(
    { type: "yield", token: TOKEN },
    { Origin: "chrome-extension://abc" },
  );
  assert.equal(withOrigin, CLOSE_CODES.AUTH_FAILED);
  const wrongToken = await sendFirstFrame({ type: "yield", token: "nope" });
  assert.equal(wrongToken, CLOSE_CODES.AUTH_FAILED);

  // Still holding: an executor connects to this instance.
  const executor = use(reconnectingExecutor());
  await sleep(300);
  assert.equal((await holder.checkConnection()).browser, true);
});

test("a holder that cannot yield leaves a message naming the cause", async (t) => {
  const use = tracker(t);
  // Stands in for a server that predates yield frames: it answers anything
  // that is not a hello with 4001, as awaitHello did.
  const old = new WebSocketServer({ host: "127.0.0.1", port: PORT });
  await new Promise((r) => old.once("listening", r));
  old.on("connection", (ws) => ws.once("message", () => ws.close(4001, "bad token")));
  use({
    async close() {
      for (const ws of old.clients) ws.terminate();
      await new Promise((r) => old.close(r));
    },
  });

  const waiting = use(new ExtensionBridge());
  await sleep(200);
  const started = Date.now();
  const status = await waiting.checkConnection();
  assert.equal(status.browser, false);
  assert.ok(Date.now() - started < 5_000, "a refusal must not wait for the executor");
  assert.ok(
    status.errors.some((e) => e.includes("did not hand it over")),
    JSON.stringify(status.errors),
  );

});

test("a waiting instance takes the port when the holder exits", async (t) => {
  const use = tracker(t);
  const first = use(await startHolder());
  const second = use(new ExtensionBridge());
  await sleep(200);
  await first.close();
  await sleep(3_500);

  const executor = use(reconnectingExecutor());
  await sleep(300);
  const status = await second.checkConnection();
  assert.equal(status.browser, true, JSON.stringify(status.errors));
});

test("a holder that is not projectionlab-mcp is named as such, without a long wait", async (t) => {
  const use = tracker(t);
  const other = createServer((req, res) => res.end("ok"));
  await new Promise((r) => other.listen(PORT, "127.0.0.1", r));
  use({
    async close() {
      other.closeAllConnections();
      await new Promise((r) => other.close(r));
    },
  });

  const waiting = use(new ExtensionBridge());
  await sleep(200);
  const started = Date.now();
  const status = await waiting.checkConnection();
  assert.equal(status.browser, false);
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started}ms`);
  assert.ok(
    status.errors.some((e) => e.includes("not projectionlab-mcp")),
    JSON.stringify(status.errors),
  );
});

test("the holder keeps the port when the instance that asked for it has gone", async (t) => {
  const use = tracker(t);
  const { holder, executor, inFlight } = await holderWithExportInFlight(use);

  const requester = rawSocket({ type: "yield", token: TOKEN });
  await sleep(200);
  requester.ws.terminate();
  await requester.closed;

  executor.release();
  assert.deepEqual(await inFlight, { marker: "data" });
  await sleep(300);
  assert.deepEqual(executor.closes, [], "the holder dropped its executor for a requester that left");
  assert.equal((await holder.checkConnection()).browser, true);
});

test("a waiting instance that shuts down withdraws its yield request", async (t) => {
  const use = tracker(t);
  const { holder, executor, inFlight } = await holderWithExportInFlight(use);

  const second = use(new ExtensionBridge());
  await sleep(200);
  const pending = second.checkConnection();
  await sleep(300);
  const started = Date.now();
  await second.close();
  assert.equal((await pending).browser, false);
  assert.ok(Date.now() - started < 1_000, "the pending operation outlived the shutdown");

  executor.release();
  assert.deepEqual(await inFlight, { marker: "data" });
  await sleep(300);
  assert.deepEqual(executor.closes, [], "the holder handed the port to an instance that shut down");
  assert.equal((await holder.checkConnection()).browser, true);
});

test("a holder shutting down answers a queued yield and finishes closing", async (t) => {
  const use = tracker(t);
  const { holder, inFlight } = await holderWithExportInFlight(use);
  inFlight.catch(() => {});

  const requester = rawSocket({ type: "yield", token: TOKEN });
  await sleep(200);
  const started = Date.now();
  await holder.close();
  assert.ok(Date.now() - started < 2_000, `close took ${Date.now() - started}ms`);
  assert.equal(await requester.closed, CLOSE_CODES.YIELDED);
});

test("a hello on a socket accepted before the hand-over is sent to the new holder", async (t) => {
  const use = tracker(t);
  const first = use(await startHolder());
  const executor = use(reconnectingExecutor());
  await sleep(300);
  const late = rawSocket();
  await new Promise((r) => late.ws.on("open", r));

  const second = use(new ExtensionBridge());
  await sleep(200);
  assert.equal((await second.checkConnection()).browser, true);

  late.ws.send(
    JSON.stringify({ type: "hello", token: TOKEN, protocolVersion: PROTOCOL_VERSION, executor: "late/1.0" }),
  );
  assert.equal(await late.closed, CLOSE_CODES.HANDED_OVER);
});

test("two instances writing plans at once: one write lands and the other gets PLAN_CONFLICT", async (t) => {
  const use = tracker(t);
  const first = use(await startHolder());
  // The extension's real 2-second reconnect and a page round trip make the
  // instances alternate one operation per hand-over, which is the order
  // that would let both conflict checks pass ahead of both writes.
  const executor = use(
    reconnectingExecutor({
      reconnectMs: 2_000,
      responseMs: 150,
      plans: [{ id: "p1", lastUpdated: 1, a: 0, b: 0 }],
    }),
  );
  await sleep(300);
  const second = use(new ExtensionBridge());
  await sleep(200);

  const write = async (bridge, field) => {
    const read = (await bridge.exportData({ fresh: true })).plans;
    await bridge.restorePlansIfUnchanged(
      read,
      read.map((p) => ({ ...p, [field]: 1 })),
    );
  };
  const [a, b] = await Promise.allSettled([
    write(first, "a"),
    sleep(100).then(() => write(second, "b")),
  ]);

  const refused = [a, b].filter((r) => r.status === "rejected");
  assert.equal(refused.length, 1, JSON.stringify([a, b]));
  assert.equal(refused[0].reason.code, "PLAN_CONFLICT");
  const [{ a: finalA, b: finalB }] = executor.plans();
  assert.deepEqual(
    { a: finalA, b: finalB },
    a.status === "fulfilled" ? { a: 1, b: 0 } : { a: 0, b: 1 },
  );
});
