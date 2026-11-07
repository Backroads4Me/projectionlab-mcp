/**
 * Wire protocol between the MCP server (WebSocket listener) and a browser-side
 * executor - the extension's service worker or a pasted Tier-0 bootstrap
 * snippet. This file is the contract both sides build against; changes here
 * require agreement from both the server and extension implementations
 * (src/extensionBridge.ts, src/bootstrap.ts, extension/src/).
 *
 * Transport: JSON text frames over ws://127.0.0.1:<port>. The browser side is
 * always the WebSocket client. The server accepts one active executor
 * connection at a time (newest wins).
 */

/** Bumped on any breaking change to frame shapes or semantics. */
export const PROTOCOL_VERSION = 1;

/** Default listen port; override with PL_WS_PORT / the extension options page. */
export const DEFAULT_WS_PORT = 8788;

/** Heartbeat interval. Also keeps the MV3 service worker alive (Chrome >=116). */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Plugin API operations the executor must support. `params` for each is an
 * ordered argument list matching window.projectionlabPluginAPI signatures,
 * except the meta-operations `describeApi` (no args; enumerates own +
 * prototype properties of the API object) and `waitForApi` (no args; resolves
 * once the API is attached to the page).
 */
export type WireMethod =
  | "exportData" // params: [{ key }]
  | "updateAccount" // params: [accountId, data, { key, force? }]
  | "restoreCurrentFinances" // params: [state, { key }]
  | "restorePlans" // params: [plans, { key }]
  | "restoreProgress" // params: [progress, { key }]
  | "restoreSettings" // params: [settings, { key }]
  | "validateApiKey" // params: [{ key }]
  | "describeApi" // params: []
  | "waitForApi"; // params: []

/** First frame the executor sends after the socket opens. */
export interface HelloFrame {
  type: "hello";
  /** Shared secret; server closes the socket with code 4001 on mismatch. */
  token: string;
  protocolVersion: number;
  /** "extension/<version>" or "bootstrap/<version>", the release version from package.json */
  executor: string;
}

/** Server acknowledges a valid hello. Requests only flow after this. */
export interface HelloAckFrame {
  type: "helloAck";
  protocolVersion: number;
}

export interface RequestFrame {
  type: "request";
  /** Unique per request; the response echoes it. */
  id: string;
  method: WireMethod;
  params: unknown[];
}

export type WireErrorCode =
  /** No ProjectionLab tab is open and auto-open is disabled or failed. */
  | "NO_TAB"
  /** Tab exists but projectionlabPluginAPI never appeared (not logged in / plugins disabled). */
  | "API_NOT_AVAILABLE"
  /** The Plugin API rejected the key. */
  | "API_KEY_INVALID"
  /** Executor-side timeout waiting on the page. */
  | "TIMEOUT"
  | "UNKNOWN";

export interface ResponseFrame {
  type: "response";
  id: string;
  ok: boolean;
  /** Present when ok. JSON-serializable result of the API call. */
  result?: unknown;
  /** Present when !ok. */
  error?: { code: WireErrorCode; message: string };
}

/** Sent by the server; the executor must reply with pong. */
export interface PingFrame {
  type: "ping";
}

export interface PongFrame {
  type: "pong";
}

export type ClientFrame = HelloFrame | ResponseFrame | PongFrame;
export type ServerFrame = HelloAckFrame | RequestFrame | PingFrame;
export type WireFrame = ClientFrame | ServerFrame;

/** WebSocket close codes used by the server. */
export const CLOSE_CODES = {
  /** hello token mismatch or malformed hello. Executor must not retry without reconfiguring. */
  AUTH_FAILED: 4001,
  /** Protocol version mismatch. */
  VERSION_MISMATCH: 4002,
  /** A newer executor connected and replaced this one. */
  REPLACED: 4003,
} as const;
