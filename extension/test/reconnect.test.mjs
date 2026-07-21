import assert from "node:assert/strict";
import test from "node:test";

test("configuration changes request a forced reconnect", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/background.js", import.meta.url), "utf8"));
  assert.match(source, /async function connect\(force = false\)/);
  assert.match(source, /changes\.port \|\| changes\.token\)\) void connect\(true\)/);
});
