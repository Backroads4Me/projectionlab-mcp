import assert from "node:assert/strict";
import test from "node:test";
import { makeResponseFrame } from "../src/wire.js";

test("page message type cannot overwrite the response frame type", () => {
  const frame = makeResponseFrame("request-1", {
    type: "plmcp:nonce:response",
    id: "untrusted-page-id",
    ok: true,
    result: { value: 42 },
  });
  assert.deepEqual(frame, {
    type: "response",
    id: "request-1",
    ok: true,
    result: { value: 42 },
    error: undefined,
  });
});

test("structured page errors survive serialization", () => {
  const error = { code: "API_KEY_INVALID", message: "Plugin API key was rejected" };
  assert.deepEqual(makeResponseFrame("request-2", { ok: false, error }), {
    type: "response",
    id: "request-2",
    ok: false,
    result: undefined,
    error,
  });
});
