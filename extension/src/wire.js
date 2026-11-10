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
