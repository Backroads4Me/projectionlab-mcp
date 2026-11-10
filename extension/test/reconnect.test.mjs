import assert from "node:assert/strict";
import test from "node:test";
import { buildHelloFrame, connectionStatusForClose, delayAfterHelloAck, isForcedConnectChange, reconnectBlockedForClose, retryDelayForClose, shouldAttemptReconnect, statusMessageForClose } from "../src/wire.js";

test("saving the options page or editing port or token forces a connect", async () => {
  assert.equal(isForcedConnectChange({ connectRequestedAt: {} }), true);
  assert.equal(isForcedConnectChange({ port: {} }), true);
  assert.equal(isForcedConnectChange({ token: {} }), true);
  assert.equal(isForcedConnectChange({ connectionStatus: {}, lastError: {} }), false);
  assert.equal(isForcedConnectChange({}), false);

  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/background.js", import.meta.url), "utf8"));
  assert.match(source, /async function connect\(force = false\)/);
  assert.match(source, /area === "local" && isForcedConnectChange\(changes\)\) void connect\(true\)/);
  const options = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/options.js", import.meta.url), "utf8"));
  // A Save writes connectRequestedAt even when no field was edited, so the
  // background always sees a storage change to force on.
  assert.match(options, /connectRequestedAt: Date\.now\(\)/);
});

test("4003 and 4004 keep retrying slowly; only auth refusals block", () => {
  // 4001/4002 cannot fix themselves; 4003/4004 end when the active
  // executor goes away, so a slow retry reconnects on its own.
  assert.equal(reconnectBlockedForClose(4001), true);
  assert.equal(reconnectBlockedForClose(4002), true);
  assert.equal(reconnectBlockedForClose(4003), false);
  assert.equal(reconnectBlockedForClose(4004), false);
  assert.equal(reconnectBlockedForClose(1006), false);
  assert.equal(reconnectBlockedForClose(1000), false);

  assert.equal(retryDelayForClose(2_000, 4004), 30_000);
  assert.equal(retryDelayForClose(4_000, 4003), 30_000);
  assert.equal(retryDelayForClose(2_000, 1006), 2_000);
  // An accepted hello after a standby cycle keeps the slow delay; after an
  // ordinary drop it resets the schedule to 2 seconds.
  assert.equal(delayAfterHelloAck(4004, 30_000), 30_000);
  assert.equal(delayAfterHelloAck(4003, 30_000), 30_000);
  assert.equal(delayAfterHelloAck(1006, 16_000), 2_000);
  assert.equal(delayAfterHelloAck(0, 30_000), 2_000);

  assert.equal(connectionStatusForClose(4004), "standby");
  assert.equal(connectionStatusForClose(4003), "disconnected");
  assert.equal(connectionStatusForClose(1006), "disconnected");
});

test("close messages tell the truth: no save-or-restart for a takeover", () => {
  assert.match(
    statusMessageForClose({ code: 4003, reason: "replaced by takeover" }),
    /took over the connection/i,
  );
  assert.doesNotMatch(statusMessageForClose({ code: 4003 }), /save the options page|restart the browser/i);
  assert.match(
    statusMessageForClose({ code: 4004, reason: "another executor holds the connection" }),
    /another browser is connected/i,
  );
  assert.doesNotMatch(statusMessageForClose({ code: 4004 }), /save the options page|restart the browser/i);
  assert.equal(
    statusMessageForClose({ code: 1006, reason: "" }),
    "Connection closed (1006).",
  );
});

test("blocked and the slow schedule gate alarm and startup connects, Save never is", () => {
  // The service worker restarts via the reconnect alarm; the persisted
  // storage.session state is what keeps it from retrying early.
  assert.equal(shouldAttemptReconnect({ blocked: true, force: false, lastAttemptAt: 0, now: 10_000, minDelayMs: 30_000 }), false);
  assert.equal(shouldAttemptReconnect({ blocked: true, force: true, lastAttemptAt: 0, now: 10_000, minDelayMs: 30_000 }), true);
  assert.equal(shouldAttemptReconnect({ blocked: false, force: false, lastAttemptAt: 0, now: 10_000, minDelayMs: 30_000 }), true);
  assert.equal(shouldAttemptReconnect({ blocked: false, force: true, lastAttemptAt: 9_990, now: 10_000, minDelayMs: 30_000 }), true);
  assert.equal(shouldAttemptReconnect({ blocked: false, force: false, lastAttemptAt: 9_990, now: 10_000, minDelayMs: 30_000 }), false);
  assert.equal(shouldAttemptReconnect({ blocked: false, force: false, lastAttemptAt: 0, now: 10_000, minDelayMs: 30_000 }), true);
});

test("the hello carries instanceId and takeover only when they are real", () => {
  const base = { token: "t", protocolVersion: 1, executor: "extension/1.2.0" };
  assert.deepEqual(buildHelloFrame(base), { type: "hello", token: "t", protocolVersion: 1, executor: "extension/1.2.0" });
  assert.deepEqual(buildHelloFrame({ ...base, instanceId: "", takeover: false }), { type: "hello", token: "t", protocolVersion: 1, executor: "extension/1.2.0" });
  assert.deepEqual(buildHelloFrame({ ...base, instanceId: "abc", takeover: true }), { type: "hello", token: "t", protocolVersion: 1, executor: "extension/1.2.0", instanceId: "abc", takeover: true });
  // Only exactly true asks for a takeover.
  assert.equal(buildHelloFrame({ ...base, takeover: "true" }).takeover, undefined);
  assert.equal(buildHelloFrame({ ...base, instanceId: 7 }).instanceId, undefined);
});
