import assert from "node:assert/strict";
import test from "node:test";
import { reconnectBlockedForClose, shouldTriggerConnect, statusMessageForClose } from "../src/wire.js";

test("configuration changes request a forced reconnect", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/background.js", import.meta.url), "utf8"));
  assert.match(source, /async function connect\(force = false\)/);
  assert.match(source, /changes\.port \|\| changes\.token\)\) void connect\(true\)/);
});

test("close code 4003 stops reconnecting with a takeover message", () => {
  // 4003 REPLACED must behave like the auth codes: no reconnect, no alarm
  // retry, until the options page is saved or the browser restarts.
  assert.equal(reconnectBlockedForClose(4003), true);
  assert.equal(reconnectBlockedForClose(4001), true);
  assert.equal(reconnectBlockedForClose(4002), true);
  assert.equal(reconnectBlockedForClose(1006), false);
  assert.equal(reconnectBlockedForClose(1000), false);

  const message = statusMessageForClose({ code: 4003, reason: "replaced by newer connection" });
  assert.match(message, /another browser or tab took over/i);
  assert.match(message, /save the options page or restart the browser/i);
  assert.equal(
    statusMessageForClose({ code: 1006, reason: "" }),
    "Connection closed (1006).",
  );
});

test("a stored block holds off alarm and startup connects but never a forced one", () => {
  // The service worker restarts via the reconnect alarm; the persisted
  // storage.session flag is what keeps a replaced executor from reconnecting.
  assert.equal(shouldTriggerConnect({ blocked: true, force: false }), false);
  assert.equal(shouldTriggerConnect({ blocked: true, force: true }), true);
  assert.equal(shouldTriggerConnect({ blocked: false, force: false }), true);
  assert.equal(shouldTriggerConnect({ blocked: false, force: true }), true);
});
