import assert from "node:assert/strict";
import test from "node:test";
import { makeResponseFrame, updateLineForVersions } from "../src/wire.js";

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

test("the options-page update line warns only when extension is older than minExtensionVersion", () => {
  assert.equal(
    updateLineForVersions("1.1.0", "1.2.0"),
    "This extension is version 1.1.0, older than the server's minimum required version (1.2.0). Check your browser's extensions page for updates.",
  );
  assert.equal(updateLineForVersions("1.2.0", "1.2.0"), "");
  assert.equal(updateLineForVersions("1.2.1", "1.2.0"), "");
  assert.equal(updateLineForVersions("2.0.0", "1.2.0"), "");
  // Missing or unparsable minExtensionVersion says nothing.
  assert.equal(updateLineForVersions("1.2.0", ""), "");
  assert.equal(updateLineForVersions("", "1.2.0"), "");
  assert.equal(updateLineForVersions("1.2.0", "v1.3.0"), "");
  assert.equal(updateLineForVersions("1.2.0", "1.3.0-beta"), "");
  assert.equal(updateLineForVersions("1.2", "1.2.0"), "");
});
