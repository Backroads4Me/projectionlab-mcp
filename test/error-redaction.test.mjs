// Tool error results never carry the Plugin API key.

import assert from "node:assert/strict";
import test from "node:test";

process.env.PL_API_KEY = "test-api-key-secret";
process.env.PL_READ_ONLY = "true";
process.env.LOG_LEVEL = "error";

const { errorResult, ProjectionLabError } = await import("../dist/errors.js");

test("errorResult scrubs the API key from an unexpected error", () => {
  const result = errorResult(new Error("request failed: key=test-api-key-secret"));
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.equal(text.includes("test-api-key-secret"), false);
  assert.equal(JSON.parse(text).message, "request failed: key=[REDACTED]");
});

test("errorResult scrubs the API key from a ProjectionLabError", () => {
  const result = errorResult(
    new ProjectionLabError("UNKNOWN", "bad test-api-key-secret", "retry test-api-key-secret"),
  );
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, {
    error: "UNKNOWN",
    message: "bad [REDACTED]",
    suggestion: "retry [REDACTED]",
  });
});
