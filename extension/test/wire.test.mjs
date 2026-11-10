import assert from "node:assert/strict";
import test from "node:test";
import { makeResponseFrame, RELEASES_URL, updateLineForVersions } from "../src/wire.js";

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

test("the options-page update line fires only on a real difference", () => {
  assert.equal(
    updateLineForVersions("1.1.0", "1.2.0"),
    "This extension is 1.1.0; the server is 1.2.0. Download the matching extension from the releases page.",
  );
  assert.equal(
    updateLineForVersions("1.2.0", "1.1.0"),
    "The server is 1.1.0; this extension is 1.2.0. Restart your AI assistant to update the server.",
  );
  assert.equal(updateLineForVersions("1.2.0", "1.2.0"), "");
  // A missing value is an older server that sends no serverVersion at all.
  assert.equal(updateLineForVersions("1.2.0", ""), "");
  assert.equal(updateLineForVersions("", "1.2.0"), "");
  assert.equal(updateLineForVersions("1.2.0", "v1.3.0"), "");
  assert.equal(updateLineForVersions("1.2.0", "1.3.0-beta"), "");
  assert.equal(updateLineForVersions("1.2", "1.2.0"), "");
  assert.equal(
    RELEASES_URL,
    "https://github.com/Backroads4Me/projectionlab-mcp/releases/latest",
  );
});
