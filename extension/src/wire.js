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
 * take turns displacing each other forever. Reconnect resumes when the user
 * saves the options page or the service worker restarts.
 */
export function reconnectBlockedForClose(code) {
  return code === 4001 || code === 4002 || code === 4003;
}

/** The status text shown for a server close. */
export function statusMessageForClose(event) {
  if (event.code === 4001) return "Authentication failed. Check the shared token.";
  if (event.code === 4002) return "Wire protocol version mismatch.";
  if (event.code === 4003)
    return "Another browser or tab took over the connection. Save the options page to reconnect.";
  return event.reason || `Connection closed (${event.code}).`;
}
