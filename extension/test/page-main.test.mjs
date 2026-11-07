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
