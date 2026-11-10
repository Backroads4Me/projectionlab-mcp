import assert from "node:assert/strict";
import test from "node:test";

test("configuration changes request a forced reconnect", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/background.js", import.meta.url), "utf8"));
  assert.match(source, /async function connect\(force = false\)/);
  assert.match(source, /changes\.port \|\| changes\.token\)\) void connect\(true\)/);
});

import { reconnectBlockedForClose, statusMessageForClose } from "../src/wire.js";

test("close code 4003 stops reconnecting with a takeover message", () => {
  // 4003 REPLACED must behave like the auth codes: no reconnect, no alarm
  // retry, until the options page is saved or the worker restarts.
  assert.equal(reconnectBlockedForClose(4003), true);
  assert.equal(reconnectBlockedForClose(4001), true);
  assert.equal(reconnectBlockedForClose(4002), true);
  assert.equal(reconnectBlockedForClose(1006), false);
  assert.equal(reconnectBlockedForClose(1000), false);

  assert.match(
    statusMessageForClose({ code: 4003, reason: "replaced by newer connection" }),
    /another browser or tab took over/i,
  );
  assert.equal(
    statusMessageForClose({ code: 1006, reason: "" }),
    "Connection closed (1006).",
  );
});
