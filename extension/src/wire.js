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
 * The server's close codes (src/types/wire.ts CLOSE_CODES). Only 4001
 * (wrong token) and 4002 (protocol mismatch) block reconnecting: they cannot
 * fix themselves, so retrying until the options page is saved or the browser
 * restarts only repeats a refused handshake. 4003 (replaced by a takeover)
 * and 4004 (another executor holds the connection) do not block; the
 * incumbent may go away at any time, so a slow retry reconnects on its own.
 * The block is persisted in browser.storage.session so a service-worker
 * restart honors it.
 */
export function reconnectBlockedForClose(code) {
  return code === 4001 || code === 4002;
}

/** Minimum delay between connection attempts once the server says another
 * executor holds the connection (4004) or took it over (4003). */
export const STANDBY_RETRY_MS = 30_000;

/**
 * The delay to wait after a close before the next attempt. 4003 and 4004
 * get the slow standby schedule with no exponential ramp-up from 2 seconds:
 * against a 1.1.0 server, which has no BUSY code, a fast schedule would let
 * two extensions replace each other every few seconds. Other closes reuse
 * the previous delay (the caller doubles it after use), so the first attempt
 * after an ordinary drop comes at 2 seconds.
 */
export function retryDelayForClose(previousDelay, code) {
  return isStandbyClose(code) ? STANDBY_RETRY_MS : previousDelay;
}

/**
 * Whether a close means another executor holds the connection: 4003 (it took
 * over) or 4004 (it was already there). The standby wait runs from this
 * close, so the caller records its time for the alarm and startup gate;
 * otherwise an alarm firing seconds after a takeover would retry at once.
 */
export function isStandbyClose(code) {
  return code === 4003 || code === 4004;
}

/** The delay for the attempt after this one: exponential up to the cap. */
export function doubledDelay(previousDelay) {
  return Math.min(previousDelay * 2, STANDBY_RETRY_MS);
}

/**
 * The connection status to show for a server close. 4003 and 4004 are both
 * standby: the extension is healthy, another browser holds the connection,
 * and a retry on the slow schedule connects by itself when that one goes
 * away.
 */
export function connectionStatusForClose(code) {
  return isStandbyClose(code) ? "standby" : "disconnected";
}

/** The status text shown for a server close. */
export function statusMessageForClose(event) {
  if (event.code === 4001) return "Authentication failed. Check the shared token.";
  if (event.code === 4002) return "Wire protocol version mismatch.";
  if (event.code === 4003) return "Another browser or tab took over the connection. This one connects on its own when that one disconnects.";
  if (event.code === 4004) return "Another browser is connected to the server. This one connects on its own when that one disconnects.";
  return event.reason || `Connection closed (${event.code}).`;
}

/**
 * Whether a storage.local change means the extension should connect now and
 * ask the server for a takeover. A new port or token value always does. An
 * options-page Save with nothing edited (it writes connectRequestedAt) does
 * so only while this executor is not the active one: when it already holds
 * the connection there is nothing to take over, and reconnecting would drop
 * a request in flight.
 *
 * Old and new values are compared because Firefox reports every key passed
 * to storage.set, including keys whose value did not change, while Chrome
 * reports only the keys that changed.
 */
export function isForcedConnectChange(changes, { authed = false } = {}) {
  if (!changes) return false;
  const differs = (change) => Boolean(change) && change.oldValue !== change.newValue;
  if (differs(changes.port) || differs(changes.token)) return true;
  return differs(changes.connectRequestedAt) && !authed;
}

/**
 * The hello frame. instanceId and takeover are omitted when absent or not
 * exactly true, so a 1.1.0 server sees exactly the old frame shape.
 */
export function buildHelloFrame({ token, protocolVersion, executor, instanceId, takeover }) {
  const frame = { type: "hello", token, protocolVersion, executor };
  if (typeof instanceId === "string" && instanceId) frame.instanceId = instanceId;
  if (takeover === true) frame.takeover = true;
  return frame;
}

/**
 * Whether an alarm or worker startup should open a connection. A forced
 * connect (the options page was saved) always proceeds; otherwise a stored
 * block from an auth refusal must be honored, and attempts must stay at
 * least minDelayMs apart (Firefox's 15-second keep-alive alarm would
 * otherwise outrun the standby schedule once the worker slept through the
 * in-worker timer).
 */
export function shouldAttemptReconnect({ blocked, force, lastAttemptAt, now, minDelayMs }) {
  if (force) return true;
  if (blocked) return false;
  // 0 means no attempt has been recorded yet (the storage.session default).
  if (typeof lastAttemptAt === "number" && lastAttemptAt > 0 && now - lastAttemptAt < minDelayMs) return false;
  return true;
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
