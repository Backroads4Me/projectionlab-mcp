// The write guard in ExtensionBridge.request (src/extensionBridge.ts).
//
// A write carries the Plugin API version the server read before preparing it.
// An executor whose hello lists the "expectApiVersion" feature is sent that
// version in the frame and checks it in the same page turn as the call. An
// executor without the feature cannot check, so it is trusted only on the
// socket the version was read from: a guarded write that would reach another
// socket is refused with CONTRACT_CHANGED before any frame is sent, because
// the new executor could be driving another ProjectionLab version.
//
// A public write takes the guard and sends the frame inside one uninterrupted
// entry on the operation chain, so the two steps only ever straddle an
// executor change if the event loop runs one between them. The CONTRACT_CHANGED
// case drives those two steps as one chain entry with the executor change
// injected between them, which is that interleaving made deterministic rather
// than raced.
//
// Run: npm run build && node --test test/write-guard-fallback.test.mjs

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "./helpers/free-port.mjs";

const PORT = await freePort();
const TOKEN = "write-guard-token";
/** ProjectionLab 5 reports Plugin API contract 2. */
const API_VERSION = 2;
const ACCOUNT_ID = "acct_brokerage";
const WRITE_PARAMS = [ACCOUNT_ID, { balance: 55_000 }, { key: "test-api-key" }];

const home = mkdtempSync(join(tmpdir(), "plmcp-write-guard-home-"));
process.env.HOME = home;
process.env.PL_API_KEY = "test-api-key";
process.env.PL_WS_PORT = String(PORT);
process.env.PL_WS_TOKEN = TOKEN;
process.env.PL_SNAPSHOT_DIR = join(home, "snapshots");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");
const { PROTOCOL_VERSION } = await import("../dist/types/wire.js");

const bridge = new ExtensionBridge();
await new Promise((r) => setTimeout(r, 200)); // let the server start listening
after(() => bridge.close());

/**
 * A fake executor on a ProjectionLab 5 page: it answers `apiVersion` with the
 * contract and every other request with success, and records each request
 * frame it receives in `requests`. `features` is the hello frame's feature
 * list; leave it out for an executor that predates "expectApiVersion", as the
 * 1.2.x executors are. `ready` resolves when the server acks the hello,
 * `closed` when the socket has closed, and `methods()` names the requests in
 * the order they arrived.
 */
function connectExecutor({ executor, features } = {}) {
  const requests = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  ws.on("open", () => {
    const hello = { type: "hello", token: TOKEN, protocolVersion: PROTOCOL_VERSION, executor };
    if (features) hello.features = [...features];
    ws.send(JSON.stringify(hello));
  });
  const ready = new Promise((resolve, reject) => {
    let acked = false;
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "helloAck") {
        acked = true;
        resolve(ws);
        return;
      }
      if (frame.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (frame.type !== "request") return;
      requests.push(frame);
      const result = frame.method === "apiVersion" ? API_VERSION : true;
      ws.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result }));
    });
    ws.on("error", reject);
    // A hello the server refuses (a BUSY stand-by, a bad token) never acks.
    closed.then(() => {
      if (!acked) reject(new Error(`${executor} closed before helloAck`));
    });
  });
  ready.catch(() => {}); // a refused hello is an answer, not a rejection to handle
  return { ws, requests, methods: () => requests.map((f) => f.method), ready, closed };
}

/** The one `updateAccount` request frame an executor was sent, or undefined. */
const writeFrame = (exec) => exec.requests.find((f) => f.method === "updateAccount");

test("an executor without the feature is sent the guarded write with no expectApiVersion field", async () => {
  const exec = connectExecutor({ executor: "fake-unguarded/1.0" });
  await exec.ready;
  try {
    await bridge.updateAccount(ACCOUNT_ID, { balance: 55_000 }, undefined, "v5");
    assert.deepEqual(exec.methods(), ["apiVersion", "updateAccount"]);
    const frame = writeFrame(exec);
    assert.equal("expectApiVersion" in frame, false, JSON.stringify(frame));
    assert.deepEqual(frame.params, WRITE_PARAMS);
  } finally {
    exec.ws.close();
    await exec.closed;
  }
});

test("an executor with the feature is sent the checked version in the frame", async () => {
  const exec = connectExecutor({
    executor: "fake-guarded/1.0",
    features: ["expectApiVersion"],
  });
  await exec.ready;
  try {
    await bridge.updateAccount(ACCOUNT_ID, { balance: 55_000 }, undefined, "v5");
    assert.deepEqual(exec.methods(), ["apiVersion", "updateAccount"]);
    const frame = writeFrame(exec);
    assert.ok("expectApiVersion" in frame, JSON.stringify(frame));
    assert.strictEqual(frame.expectApiVersion, API_VERSION);
  } finally {
    exec.ws.close();
    await exec.closed;
  }
});

test("a guarded write is refused with CONTRACT_CHANGED once another executor holds the connection", async () => {
  const first = connectExecutor({ executor: "fake-first/1.0" });
  await first.ready;

  let second;
  const write = bridge.serialize(async () => {
    // The guard is read on `first`'s socket, exactly as bridge.updateAccount
    // reads it ahead of its own send.
    const guard = await bridge.assertWriteSupported("updateAccount", "v5");

    // The page reloads onto a different executor between the version check
    // and the write: the unguarded executor that is connected now could be
    // driving any ProjectionLab version.
    first.ws.close();
    await first.closed;
    second = connectExecutor({ executor: "fake-second/1.0" });
    await second.ready;

    // The write's own send, with the params bridge.updateAccount sends.
    await bridge.request("updateAccount", WRITE_PARAMS, undefined, guard);
  });

  await assert.rejects(
    write,
    (err) => {
      assert.equal(err.code, "CONTRACT_CHANGED", JSON.stringify(err));
      assert.match(err.message, /browser executor changed after the Plugin API version was checked/);
      assert.match(err.suggestion, /Nothing was written/);
      return true;
    },
    "the write reached an executor the version was never checked on",
  );
  try {
    assert.deepEqual(second.requests, [], "the second executor was sent a frame");
    assert.equal(writeFrame(first), undefined, "the first executor was sent the write either");
  } finally {
    second?.ws.close();
    await second?.closed;
  }
});
