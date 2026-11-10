export function makeResponseFrame(requestId, response) {
  return {
    type: "response",
    id: requestId,
    ok: response.ok,
    result: response.result,
    error: response.error,
  };
}

/**
 * The server's close codes (src/types/wire.ts CLOSE_CODES). 4003 REPLACED
 * must stop reconnecting: two executors that each reconnect on being replaced
 * take turns displacing each other forever. The block is persisted in
 * browser.storage.session so a service-worker restart honors it; reconnecting
 * resumes when the user saves the options page or restarts the browser.
 */
export function reconnectBlockedForClose(code) {
  return code === 4001 || code === 4002 || code === 4003;
}

/**
 * Whether an alarm or worker startup should open a connection. A forced
 * connect (the options page was saved) always proceeds; otherwise a stored
 * block from an earlier refused close must be honored, otherwise the worker
 * restart that follows a 30-second idle teardown would reconnect anyway.
 */
export function shouldTriggerConnect({ blocked, force }) {
  return force || !blocked;
}

/** The status text shown for a server close. */
export function statusMessageForClose(event) {
  if (event.code === 4001) return "Authentication failed. Check the shared token.";
  if (event.code === 4002) return "Wire protocol version mismatch.";
  if (event.code === 4003)
    return "Another browser or tab took over the connection. Save the options page or restart the browser to reconnect.";
  return event.reason || `Connection closed (${event.code}).`;
}

// Mirrors src/versionCompare.ts on the server; the extension is a separate
// package and cannot import from src/. Keep the two in sync.
function parseVersion(version) {
  if (typeof version !== "string") return null;
  const parts = version.split(".");
  if (parts.length !== 3) return null;
  const numbers = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d*)$/.test(part)) return null;
    numbers.push(Number(part));
  }
  return numbers;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export const RELEASES_URL =
  "https://github.com/Backroads4Me/projectionlab-mcp/releases/latest";

/**
 * The options-page line about the connected server's release, or "" when
 * there is nothing to say: equal versions, a missing value (an older server
 * sends no serverVersion), or an unparsable version.
 */
export function updateLineForVersions(extensionVersion, serverVersion) {
  const cmp = compareVersions(extensionVersion, serverVersion);
  if (cmp === 0 || cmp === null) return "";
  if (cmp < 0)
    return `This extension is ${extensionVersion}; the server is ${serverVersion}. Download the matching extension from the releases page.`;
  return `The server is ${serverVersion}; this extension is ${extensionVersion}. Restart your AI assistant to update the server.`;
}
