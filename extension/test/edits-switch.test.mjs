import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildHelloFrame, buildSettingsFrame, editRefusal, isWriteMethod, READ_METHODS } from "../src/wire.js";

const WRITE_METHODS = ["updateAccount", "restoreCurrentFinances", "restorePlans", "restoreProgress", "restoreSettings"];

test("every write is refused while Enable agent plan edits is off", () => {
  for (const method of WRITE_METHODS) {
    for (const off of [false, undefined, "true", 1]) {
      const refusal = editRefusal(method, off);
      assert.equal(refusal?.code, "EDITS_DISABLED", `${method} with ${JSON.stringify(off)}`);
    }
    assert.equal(editRefusal(method, true), null, method);
  }
});

test("reads run whether the switch is on or off", () => {
  assert.deepEqual([...READ_METHODS].sort(), ["describeApi", "exportData", "validateApiKey", "waitForApi"]);
  for (const method of READ_METHODS) {
    assert.equal(editRefusal(method, false), null, method);
    assert.equal(editRefusal(method, true), null, method);
  }
});

test("a method the extension does not know counts as a write", () => {
  assert.equal(isWriteMethod("someFutureMethod"), true);
  assert.equal(editRefusal("someFutureMethod", false)?.code, "EDITS_DISABLED");
});

test("the hello and settings frames carry the switch as a boolean", () => {
  const base = { token: "t", protocolVersion: 1, executor: "extension/1.3.0" };
  assert.equal(buildHelloFrame(base).allowEdits, false);
  assert.equal(buildHelloFrame({ ...base, allowEdits: "yes" }).allowEdits, false);
  assert.equal(buildHelloFrame({ ...base, allowEdits: true }).allowEdits, true);
  assert.deepEqual(buildSettingsFrame(true), { type: "settings", allowEdits: true });
  assert.deepEqual(buildSettingsFrame(undefined), { type: "settings", allowEdits: false });
});

test("the background checks the switch from storage before running a request in the tab", async () => {
  const source = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
  const guard = source.slice(source.indexOf("async function guardedExecute"), source.indexOf("async function handleRequest"));
  assert.match(guard, /browser\.storage\.local\.get\(\{ allowEdits: false \}\)/);
  assert.ok(guard.indexOf("editRefusal(") < guard.indexOf("executeInTab("), "the refusal comes before the tab runs anything");
  assert.match(source, /const operation = guardedExecute\(request\)/);
  assert.match(source, /"TIMEOUT", "EDITS_DISABLED"\]/);
  // Turning the switch on or off is reported on the open connection; it
  // never forces a reconnect.
  assert.match(source, /else if \(changes\.allowEdits && authed && socket\) void sendSettings\(socket\)/);
  const options = await readFile(new URL("../src/options.js", import.meta.url), "utf8");
  assert.match(options, /browser\.storage\.local\.set\(\{ allowEdits: elements\.allowEdits\.checked \}\)/);
  assert.match(options, /allowEdits: false,/, "the switch defaults to off");
});
