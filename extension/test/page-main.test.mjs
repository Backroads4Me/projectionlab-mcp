import assert from "node:assert/strict";
import test from "node:test";
import { executePageRequest } from "../src/page-main.js";

test("waitForApi honours the requested timeout", async () => {
  globalThis.window = {};
  const started = Date.now();
  const response = await executePageRequest({ method: "waitForApi", params: [600] });
  const elapsed = Date.now() - started;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "API_NOT_AVAILABLE");
  assert.ok(elapsed >= 500 && elapsed < 3_000, `waited ${elapsed} ms`);
});

test("waitForApi resolves once the API is present", async () => {
  globalThis.window = { projectionlabPluginAPI: {} };
  assert.deepEqual(await executePageRequest({ method: "waitForApi", params: [600] }), {
    ok: true,
    result: true,
  });
});

test("a method outside the wire protocol is refused without touching the API", async () => {
  let called = false;
  globalThis.window = { projectionlabPluginAPI: { wipeEverything: () => { called = true; } } };
  const response = await executePageRequest({ method: "wipeEverything", params: [] });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "UNKNOWN");
  assert.match(response.error.message, /Not a wire protocol method: wipeEverything/);
  assert.equal(called, false);
});

test("a wire protocol method reaches the API", async () => {
  globalThis.window = { projectionlabPluginAPI: { exportData: async ({ key }) => ({ key }) } };
  assert.deepEqual(await executePageRequest({ method: "exportData", params: [{ key: "k" }] }), {
    ok: true,
    result: { key: "k" },
  });
});

test("only genuine key errors classify as API_KEY_INVALID", async () => {
  const cases = [
    ["the plugin api key is wrong", "API_KEY_INVALID"],
    ["invalid key", "API_KEY_INVALID"],
    ["HTTP 401 Unauthorized", "API_KEY_INVALID"],
    ["status 401 from the api", "API_KEY_INVALID"],
    ["status 403", "API_KEY_INVALID"],
    ["your balance is 14010 dollars", "UNKNOWN"],
    ["code 14010 and 40300 are unrelated numbers", "UNKNOWN"],
    ["a401b and x403y are part of words", "UNKNOWN"],
  ];
  for (const [message, code] of cases) {
    globalThis.window = {
      projectionlabPluginAPI: {
        exportData: async () => {
          throw new Error(message);
        },
      },
    };
    const response = await executePageRequest({ method: "exportData", params: [{ key: "k" }] });
    assert.equal(response.ok, false, message);
    assert.equal(response.error.code, code, message);
  }
});
