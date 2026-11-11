import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { buildBootstrapSnippet } from "./bootstrap.js";
import type { Bridge, ConnectionStatus } from "./bridge.js";
import { config, USER_ENV_FILE } from "./config.js";
import { ProjectionLabError } from "./errors.js";
import { log } from "./logger.js";
import { planChanges, planConflictError } from "./planVersion.js";
import type { ExportedData } from "./types/projectionlab.js";
import { VERSION } from "./version.js";
import {
  CLOSE_CODES,
  HEARTBEAT_INTERVAL_MS,
  MIN_EXTENSION_VERSION,
  PROTOCOL_VERSION,
  type ClientFrame,
  type RequestFrame,
  type ResponseFrame,
  type WireErrorCode,
  type WireMethod,
} from "./types/wire.js";

/** Origins allowed to open the WebSocket. Extensions plus the PL app itself
 * (Tier 0 bootstrap snippet runs in page context, so the browser sends the
 * app origin). Sockets with no Origin header (native clients, e.g. the fake
 * test executor) are allowed; the hello token still gates them. */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return (
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin === new URL(config.appUrl).origin
  );
}

const HELLO_TIMEOUT_MS = 5_000;
/** Bytes a connection may send before its hello is read. A hello frame is a
 * few hundred bytes; the cap stops an unauthenticated peer from making the
 * server buffer a large frame (ws allows 100 MiB by default). */
const MAX_PRE_HELLO_BYTES = 64 * 1024;
/** How often to retry the WebSocket port while another instance holds it. */
const PORT_RETRY_MS = 3_000;
/** After the holder yields, how long and how often to retry the bind. The
 * extension reconnects about 2 seconds after an ordinary close, so the port
 * must be bound well before then. */
const TAKEOVER_BIND_MS = 2_000;
const TAKEOVER_RETRY_MS = 100;
/** After taking the port over, how long an operation waits for the executor
 * to reconnect (the extension retries at about 2, 6, then 14 seconds). */
const EXECUTOR_WAIT_MS = 15_000;
/** How long to wait for the holder to yield. The holder first finishes its
 * queued operations, each of which can take up to REQUEST_TIMEOUT_MS. */
const YIELD_TIMEOUT_MS = 75_000;
/** How long the holder has to answer the WebSocket upgrade on a yield socket.
 * A process that does not is not projectionlab-mcp. */
const YIELD_HANDSHAKE_MS = 5_000;
/** How many times one operation asks for the port. Another waiting instance
 * can win the bind after a yield; the next round asks that instance. */
const TAKEOVER_ROUNDS = 3;

/** Why a yield request got no port: the holder refused it (4001), did not
 * release the port within YIELD_TIMEOUT_MS, or does not speak WebSocket. */
type YieldFailure = "refused" | "slow" | "foreign";
const EXTENSION_HELP =
  "Install the MCP Bridge for ProjectionLab extension from the Chrome Web Store " +
  "(https://chromewebstore.google.com/detail/mcp-bridge-for-projection/njgjmcihabchffonldcgfjiocjalpoaf) " +
  "or Firefox Add-ons (https://addons.mozilla.org/en-US/firefox/addon/mcp-bridge-for-projectionlab/); " +
  "the store keeps it up to date. Then enter the token from " +
  "~/.projectionlab-mcp/ws-token on its options page, and open https://app.projectionlab.com. " +
  "Or call projectionlab_get_bootstrap and paste the snippet into the ProjectionLab tab's console. " +
  "Install the extension from one source only: an unpacked copy alongside a store copy leaves the " +
  "browser with two extensions competing for the server's single connection, and one of them stands by.";
const REQUEST_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Parses one text frame. Returns null unless it is a JSON object: valid JSON
 * such as `null` or `42` has no `type` to read. */
function parseFrame(raw: unknown): ClientFrame | null {
  try {
    const frame: unknown = JSON.parse(String(raw));
    return frame && typeof frame === "object" ? (frame as ClientFrame) : null;
  } catch {
    return null;
  }
}

/** Best-effort chmod; a file the process does not own keeps its mode. */
function restrictMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Not the owner, or a filesystem without POSIX modes.
  }
}

export class ExtensionBridge implements Bridge {
  private wss: WebSocketServer | null = null;
  private conn: WebSocket | null = null;
  private connExecutor = "";
  private connInstanceId = "";
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private heartbeat: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  private readonly token: string;
  private portBusy = false;
  private retryTimer: NodeJS.Timeout | null = null;
  /** While non-zero, bind retries run every TAKEOVER_RETRY_MS until this time. */
  private fastBindUntil = 0;
  /** Why the last yield request failed; "" when none has. */
  private yieldFailure: YieldFailure | "" = "";
  /** The socket of a yield request in flight. */
  private yieldPeer: WebSocket | null = null;
  /** When this instance last released the port to another instance. */
  private yieldedAt = 0;
  /** Callbacks run whenever the connection or port state changes. */
  private readonly stateWaiters = new Set<() => void>();
  private closed = false;

  // Serialize all operations and cache the last full export until a write
  // invalidates it.
  private opChain: Promise<unknown> = Promise.resolve();
  private exportCache: { data: ExportedData; at: number } | null = null;

  constructor() {
    this.token = config.wsToken ?? this.loadOrCreateToken();
    this.listen();
  }

  /** Reads or creates `~/.projectionlab-mcp/ws-token`, keeping the folder
   * 0700 and the file 0600 even when they already existed with looser modes. */
  private loadOrCreateToken(): string {
    const dir = dirname(USER_ENV_FILE);
    const file = join(dir, "ws-token");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    restrictMode(dir, 0o700);
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) {
        restrictMode(file, 0o600);
        return existing;
      }
    } catch {
      // No token yet.
    }
    const token = randomBytes(24).toString("base64url");
    writeFileSync(file, token + "\n", { mode: 0o600 });
    restrictMode(file, 0o600);
    log.info("extension", `Generated WebSocket token at ${file}`);
    return token;
  }

  private notifyState(): void {
    for (const waiter of [...this.stateWaiters]) waiter();
  }

  private scheduleListen(delayMs: number): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.listen();
    }, delayMs);
    this.retryTimer.unref();
  }

  /** Binds the WebSocket port. While another instance (another agent on
   * this machine) holds it, retries every PORT_RETRY_MS, so it takes over
   * once that instance exits; an operation arriving meanwhile asks the
   * holder to yield (requestPort). Executors reconnect on their own
   * schedule. */
  private listen(): void {
    if (this.closed || this.wss) return;
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: config.wsPort,
    });
    this.wss = wss;
    wss.on("listening", () => {
      if (this.portBusy) {
        log.info("extension", `Port ${config.wsPort} is free; took over the listener`);
      }
      this.portBusy = false;
      this.fastBindUntil = 0;
      this.yieldFailure = "";
      // A yield request still out is moot once this instance holds the port.
      this.yieldPeer?.terminate();
      log.info("extension", `Listening on ws://127.0.0.1:${config.wsPort}`);
      this.notifyState();
    });
    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        if (!this.portBusy) {
          log.warn(
            "extension",
            `Port ${config.wsPort} is held by another process (usually another agent's ` +
              `projectionlab-mcp). Retrying every ${PORT_RETRY_MS / 1000}s; an operation arriving ` +
              "here asks the holder to hand the port over.",
          );
        }
        this.portBusy = true;
        if (this.wss === wss) this.wss = null;
        wss.close();
        const fast = this.fastBindUntil > Date.now();
        if (!fast && this.fastBindUntil !== 0) {
          this.fastBindUntil = 0;
          this.notifyState();
        }
        this.scheduleListen(fast ? TAKEOVER_RETRY_MS : PORT_RETRY_MS);
        return;
      }
      log.error("extension", `WebSocket server error: ${err.message}`);
    });
    wss.on("connection", (ws, req) => {
      // A socket emits "error" on a malformed frame (RFC 6455 5.1: client
      // frames must be masked), and an EventEmitter with no "error" listener
      // throws, which would end the process. Listen from the first moment, so
      // a peer that never authenticates cannot take the server down; an
      // adopted executor's errors are logged by adopt().
      ws.on("error", (err) => {
        if (this.conn !== ws) {
          log.warn("extension", `Socket error before authentication: ${err.message}`);
        }
      });
      const origin = req.headers.origin;
      if (!originAllowed(origin)) {
        log.warn("extension", `Rejected connection from origin ${origin}`);
        ws.close(CLOSE_CODES.AUTH_FAILED, "origin not allowed");
        return;
      }
      const socket = req.socket;
      let preHelloBytes = 0;
      const countPreHelloBytes = (chunk: Buffer) => {
        preHelloBytes += chunk.length;
        if (preHelloBytes > MAX_PRE_HELLO_BYTES) {
          log.warn("extension", `Dropped connection from ${origin ?? "(no origin)"}: too much data before hello`);
          socket.off("data", countPreHelloBytes);
          socket.destroy();
        }
      };
      socket.on("data", countPreHelloBytes);
      this.awaitHello(ws, wss, origin, () => socket.off("data", countPreHelloBytes));
    });
  }

  /** New sockets must send a valid hello (or, from another server instance,
   * a yield) before anything else. `helloRead` runs once the first message
   * arrives, whatever it holds. */
  private awaitHello(
    ws: WebSocket,
    wss: WebSocketServer,
    rawOrigin: string | undefined,
    helloRead: () => void,
  ): void {
    const origin = rawOrigin ?? "(no origin)";
    const timer = setTimeout(() => {
      ws.close(CLOSE_CODES.AUTH_FAILED, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    ws.once("message", (raw) => {
      clearTimeout(timer);
      helloRead();
      const hello = parseFrame(raw);
      if (!hello) {
        ws.close(CLOSE_CODES.AUTH_FAILED, "malformed hello");
        return;
      }
      if (hello.type === "yield") {
        // Only another server process sends a yield; a browser always sends
        // an Origin header, so a socket carrying one is refused outright.
        if (rawOrigin !== undefined || hello.token !== this.token) {
          log.warn("extension", `Refused a yield request from ${origin}`);
          ws.close(CLOSE_CODES.AUTH_FAILED, "yield refused");
          return;
        }
        this.yieldPort(ws);
        return;
      }
      if (hello.type !== "hello" || hello.token !== this.token) {
        log.warn("extension", `Auth failed for connection from ${origin}`);
        ws.close(CLOSE_CODES.AUTH_FAILED, "bad token");
        return;
      }
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        log.warn(
          "extension",
          `Protocol mismatch: executor ${hello.executor} speaks v${hello.protocolVersion}, server v${PROTOCOL_VERSION}`,
        );
        ws.close(CLOSE_CODES.VERSION_MISMATCH, "protocol version mismatch");
        return;
      }
      // A socket accepted before this instance released the port must not
      // become its executor: the browser belongs to the new holder. The
      // ordinary close sends the executor there.
      if (this.wss !== wss) {
        ws.close(CLOSE_CODES.HANDED_OVER, "port handed over");
        return;
      }
      // Only authenticated hellos reach the connection decision, so an
      // unauthenticated client can neither displace an executor nor learn
      // that one is connected.
      const instanceId =
        typeof hello.instanceId === "string" &&
        hello.instanceId.length >= 1 &&
        hello.instanceId.length <= 64
          ? hello.instanceId
          : "";
      this.admit(ws, hello.executor, instanceId, hello.takeover === true);
    });
  }

  /**
   * Decide whether an authenticated hello becomes the active executor. The
   * incumbent keeps the connection: a newcomer is refused with BUSY unless it
   * requests takeover, or repeats the incumbent's instance id (an executor
   * must never be locked out by its own stale socket). An incumbent whose
   * socket is not open is dead and gets dropped first; the heartbeat is what
   * clears a crashed incumbent that still looks open.
   */
  private admit(
    ws: WebSocket,
    executor: string,
    instanceId: string,
    takeover: boolean,
  ): void {
    const incumbent = this.conn;
    if (!incumbent || incumbent.readyState !== WebSocket.OPEN) {
      if (incumbent) this.dropConnection("dropping a dead executor connection");
      this.adopt(ws, executor, instanceId);
      return;
    }
    if (takeover || (instanceId !== "" && instanceId === this.connInstanceId)) {
      this.adopt(ws, executor, instanceId);
      return;
    }
    log.info(
      "extension",
      `Refusing ${executor} with BUSY: ${this.connExecutor} holds the connection`,
    );
    ws.close(CLOSE_CODES.BUSY, "another executor holds the connection");
  }

  /** Promote an authenticated socket to the active connection. Replacing a
   * live incumbent (takeover or same instance id) closes it with 4003. */
  private adopt(ws: WebSocket, executor: string, instanceId: string): void {
    if (this.conn && this.conn !== ws) {
      log.info("extension", `Replacing ${this.connExecutor} with ${executor}`);
      this.conn.close(CLOSE_CODES.REPLACED, "replaced by newer connection");
      // The replaced executor's state must not leak into the new one: its
      // cached export could be served from the previous browser, its
      // unanswered requests would hang until the 60s timeout, and a pong the
      // old executor never sent must not drop the new one at the next
      // heartbeat tick. The new socket and the heartbeat stay as they are.
      this.exportCache = null;
      this.awaitingPong = false;
      this.abandonRequests("executor was replaced");
    }
    this.conn = ws;
    this.connExecutor = executor;
    this.connInstanceId = instanceId;
    log.info("extension", `Executor connected: ${executor}`);
    ws.send(
      JSON.stringify({
        type: "helloAck",
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: VERSION,
        minExtensionVersion: MIN_EXTENSION_VERSION,
      }),
    );

    ws.on("message", (raw) => this.onFrame(ws, raw));
    ws.on("close", () => {
      if (this.conn === ws) {
        log.warn("extension", `Executor disconnected: ${this.connExecutor}`);
        this.dropConnection("executor disconnected");
      }
    });
    ws.on("error", (err) => {
      log.warn("extension", `Socket error from ${executor}: ${err.message}`);
    });
    this.startHeartbeat();
    this.notifyState();
  }

  /**
   * Hand the port to the server instance that sent a yield frame on `peer`.
   * Runs on the operation chain, so an operation already sent to the
   * browser finishes before the executor is dropped. The executor is closed
   * with HANDED_OVER, an ordinary code, so it reconnects within seconds and
   * reaches the new holder. This instance then waits for the port like any
   * other, and asks for it back when its next operation arrives.
   */
  private yieldPort(peer: WebSocket): void {
    log.info("extension", "Another projectionlab-mcp instance asked for the port");
    void this.serialize(async () => {
      const wss = this.wss;
      if (this.closed || !wss || peer.readyState !== WebSocket.OPEN) {
        // This instance no longer holds the port (it yielded to someone
        // else meanwhile, or is shutting down), so the port is released as
        // far as this peer is concerned.
        peer.close(CLOSE_CODES.YIELDED, "port released");
        return;
      }
      this.wss = null;
      wss.close();
      this.dropConnection(
        "handed the connection to another projectionlab-mcp instance",
        CLOSE_CODES.HANDED_OVER,
      );
      this.portBusy = true;
      this.yieldedAt = Date.now();
      peer.close(CLOSE_CODES.YIELDED, "port released");
      log.info("extension", `Released port ${config.wsPort} to another projectionlab-mcp instance`);
      this.scheduleListen(PORT_RETRY_MS);
      this.notifyState();
    });
  }

  /**
   * Ask the instance holding the port to yield it. Resolves "yielded" when
   * it closes the socket with YIELDED, and "free" when nothing accepts the
   * connection or the holder drops it (it just exited). Otherwise resolves
   * the failure: "refused" when the holder answers 4001 (a server that
   * predates yield frames, or one with a different token), "slow" when a
   * holder that accepted the socket does not release the port within
   * YIELD_TIMEOUT_MS, and "foreign" when the holder does not complete a
   * WebSocket upgrade (a process that is not projectionlab-mcp).
   */
  private requestPort(): Promise<"yielded" | "free" | YieldFailure> {
    return new Promise((resolve) => {
      const peer = new WebSocket(`ws://127.0.0.1:${config.wsPort}`);
      this.yieldPeer = peer;
      let failure: YieldFailure | "" = "";
      const giveUp = (why: YieldFailure) => {
        failure = why;
        peer.terminate();
      };
      const handshakeTimer = setTimeout(() => giveUp("foreign"), YIELD_HANDSHAKE_MS);
      const timer = setTimeout(() => giveUp("slow"), YIELD_TIMEOUT_MS);
      handshakeTimer.unref();
      timer.unref();
      peer.on("open", () => {
        clearTimeout(handshakeTimer);
        peer.send(JSON.stringify({ type: "yield", token: this.token }));
      });
      peer.on("unexpected-response", () => giveUp("foreign"));
      peer.on("error", (err) => {
        log.debug("extension", `Yield request socket error: ${err.message}`);
      });
      peer.on("close", (code) => {
        clearTimeout(handshakeTimer);
        clearTimeout(timer);
        if (this.yieldPeer === peer) this.yieldPeer = null;
        if (code === CLOSE_CODES.YIELDED) resolve("yielded");
        else if (code === CLOSE_CODES.AUTH_FAILED) resolve("refused");
        else resolve(failure || "free");
      });
    });
  }

  /** Resolves once `done()` holds, rechecked on every state change, or
   * after `timeoutMs`. */
  private waitForState(done: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.stateWaiters.delete(check);
        resolve();
      };
      const check = () => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.stateWaiters.add(check);
      check();
    });
  }

  /**
   * The connected executor's socket. While another instance holds the port,
   * asks it to yield, binds the port, and waits for the executor to
   * reconnect here. When another waiting instance wins the bind instead, the
   * next round asks that instance. Runs on the operation chain, so
   * concurrent operations send one yield between them.
   */
  private async executorSocket(): Promise<WebSocket> {
    for (
      let round = 0;
      round < TAKEOVER_ROUNDS && !this.conn && this.portBusy && !this.closed;
      round++
    ) {
      // Right after yielding, the new holder may not have bound the port
      // yet; asking now would find it free and race that instance for it.
      // Waiting out its bind window means the request reaches the new
      // holder and becomes an ordinary yield.
      const sinceYield = Date.now() - this.yieldedAt;
      if (sinceYield < TAKEOVER_BIND_MS) {
        await new Promise((r) => setTimeout(r, TAKEOVER_BIND_MS - sinceYield));
      }
      // The bind retry may have taken the port during that wait; a yield
      // sent then would reach this instance's own listener.
      if (this.portBusy && !this.closed) {
        const outcome = await this.requestPort();
        if (outcome !== "yielded" && outcome !== "free") {
          this.yieldFailure = outcome;
          break;
        }
        if (this.portBusy && !this.closed) {
          log.info("extension", `Taking over port ${config.wsPort}`);
          this.yieldFailure = "";
          this.fastBindUntil = Date.now() + TAKEOVER_BIND_MS;
          if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
          }
          // An attempt in flight retries on the fast schedule from its error
          // handler; otherwise start one now.
          this.listen();
        }
      }
      await this.waitForState(
        () => this.conn !== null || this.closed || (this.portBusy && this.fastBindUntil === 0),
        EXECUTOR_WAIT_MS,
      );
    }
    if (!this.conn) {
      throw new ProjectionLabError(
        "EXTENSION_NOT_CONNECTED",
        "No browser-side executor is connected",
        this.notConnectedReason(),
      );
    }
    return this.conn;
  }

  private onFrame(ws: WebSocket, raw: unknown): void {
    if (this.conn !== ws) return;
    const frame = parseFrame(raw);
    if (!frame) {
      log.warn("extension", "Dropping malformed frame");
      return;
    }
    if (frame.type === "pong") {
      this.awaitingPong = false;
      return;
    }
    if (frame.type === "response") {
      this.settle(frame);
      return;
    }
  }

  private settle(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      const code = frame.error?.code ?? "UNKNOWN";
      const message = frame.error?.message ?? "executor reported an error";
      pending.reject(this.wireError(code, message));
    }
  }

  private wireError(code: WireErrorCode, message: string): ProjectionLabError {
    switch (code) {
      case "NO_TAB":
        return new ProjectionLabError(
          "PAGE_NOT_LOADED",
          `No ProjectionLab tab: ${message}`,
          "Open https://app.projectionlab.com in the browser running the bridge extension",
        );
      case "API_NOT_AVAILABLE":
        return new ProjectionLabError(
          "API_NOT_AVAILABLE",
          message,
          "Make sure you are logged in to ProjectionLab and plugins are enabled in Account Settings",
        );
      case "API_KEY_INVALID":
        return new ProjectionLabError(
          "API_KEY_INVALID",
          message,
          "Check that PL_API_KEY matches your key in Account Settings > Plugins",
        );
      case "TIMEOUT":
        return new ProjectionLabError(
          "TIMEOUT",
          message,
          "The ProjectionLab page did not respond in time - check the tab and try again",
        );
      default:
        return new ProjectionLabError(
          "UNKNOWN",
          message,
          "The Plugin API rejected the operation. Verify the payload shape against a fresh export and try again.",
        );
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.awaitingPong = false;
    this.heartbeat = setInterval(() => {
      if (!this.conn) return;
      if (this.awaitingPong) {
        log.warn("extension", "Heartbeat missed; dropping executor");
        this.conn.terminate();
        this.dropConnection("heartbeat missed");
        return;
      }
      this.awaitingPong = true;
      this.conn.send(JSON.stringify({ type: "ping" }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Reject every in-flight request; the executor that was sent to is gone. */
  private abandonRequests(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new ProjectionLabError(
          "EXTENSION_NOT_CONNECTED",
          `Request ${id} aborted: ${reason}`,
          "The browser-side executor disconnected mid-request. Check the browser and retry.",
        ),
      );
    }
    this.pending.clear();
  }

  /** Forget the executor. With `closeCode`, the socket gets a close frame
   * carrying that code; otherwise it is terminated. */
  private dropConnection(reason: string, closeCode?: number): void {
    // Close the socket if it's still live - wss.close() waits for all
    // clients, so leaving it open would hang shutdown.
    try {
      if (closeCode === undefined) this.conn?.terminate();
      else this.conn?.close(closeCode, reason);
    } catch {
      // Already gone.
    }
    this.conn = null;
    this.connExecutor = "";
    this.connInstanceId = "";
    this.awaitingPong = false;
    this.exportCache = null;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.abandonRequests(reason);
    this.notifyState();
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.catch(() => {});
    return next;
  }

  /** Why no executor can be reached, with the fix, for error messages. */
  private notConnectedReason(): string {
    if (this.portBusy && this.yieldFailure === "refused") {
      return (
        `Port ${config.wsPort} is held by another process that did not hand it over. Usually that ` +
        "is an older projectionlab-mcp started by another agent or session on this machine (older " +
        "versions cannot hand the port over), or one started with a different PL_WS_TOKEN. Close " +
        "that session or quit its MCP host (or update its projectionlab-mcp); this server takes " +
        "over within seconds of the port coming free."
      );
    }
    if (this.portBusy && this.yieldFailure === "slow") {
      return (
        `Port ${config.wsPort} is held by another projectionlab-mcp instance that is still busy ` +
        "with its own operations and did not release the port in time. Try again shortly."
      );
    }
    if (this.portBusy && this.yieldFailure === "foreign") {
      return (
        `Port ${config.wsPort} is held by a program that is not projectionlab-mcp. Stop that ` +
        "program, or set PL_WS_PORT to a free port for this server and enter the same port on " +
        "the extension's options page."
      );
    }
    if (this.portBusy) {
      return (
        `Port ${config.wsPort} is held by another projectionlab-mcp instance, and handing it over ` +
        "to this one did not complete. Try again; if it keeps failing, close the other agent's " +
        "session or quit its MCP host."
      );
    }
    return `No browser-side executor is connected to ws://127.0.0.1:${config.wsPort}. ${EXTENSION_HELP}`;
  }

  private requireApiKey(): string {
    if (!config.apiKey) {
      throw new ProjectionLabError(
        "API_KEY_MISSING",
        "PL_API_KEY is not set",
        "Copy the Plugin API Key from ProjectionLab Account Settings > Plugins and set PL_API_KEY " +
          `in this MCP server's env block or in ${USER_ENV_FILE}, then restart the MCP host`,
      );
    }
    return config.apiKey;
  }

  /** Send one request to the executor. Call only from the operation chain. */
  private async request(
    method: WireMethod,
    params: unknown[],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const conn = await this.executorSocket();
    const id = String(this.nextId++);
    const frame: RequestFrame = { type: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProjectionLabError(
            "TIMEOUT",
            `${method} timed out after ${timeoutMs}ms`,
            "The browser did not respond - check that the ProjectionLab tab is open and responsive",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      conn.send(JSON.stringify(frame));
    });
  }

  /** Tier 0: console snippet that turns a PL tab into the executor. */
  bootstrapSnippet(): string {
    return buildBootstrapSnippet(config.wsPort, this.token);
  }

  invalidateCache(): void {
    this.exportCache = null;
  }

  async checkConnection(): Promise<ConnectionStatus> {
    const result: ConnectionStatus = {
      browser: false,
      pageLoaded: false,
      apiAvailable: false,
      apiKeyValid: false,
      errors: [],
    };
    return this.serialize(async () => {
      if (!config.apiKey) {
        try {
          this.requireApiKey();
        } catch (err) {
          const e = err as ProjectionLabError;
          result.errors.push(`${e.code}: ${e.message}. ${e.suggestion}`);
        }
      }
      try {
        await this.executorSocket();
      } catch {
        result.errors.push(`EXTENSION_NOT_CONNECTED: ${this.notConnectedReason()}`);
        return result;
      }
      result.browser = true;
      result.executor = this.connExecutor || undefined;
      try {
        await this.request(
          "waitForApi",
          [config.apiReadyTimeoutMs],
          config.apiReadyTimeoutMs + 5_000,
        );
        result.pageLoaded = true;
        result.apiAvailable = true;
      } catch (err) {
        if (err instanceof ProjectionLabError && err.code === "API_NOT_AVAILABLE") {
          result.pageLoaded = true;
        }
        result.errors.push(
          err instanceof ProjectionLabError
            ? `${err.code}: ${err.message}. ${err.suggestion}`
            : String(err),
        );
        return result;
      }
      if (!config.apiKey) return result;
      try {
        await this.request("validateApiKey", [{ key: config.apiKey }]);
        result.apiKeyValid = true;
      } catch {
        result.errors.push(
          "API key rejected. Check PL_API_KEY matches your Plugin API Key in Account Settings.",
        );
      }
      return result;
    });
  }

  async describePluginApi(): Promise<Record<string, string>> {
    return this.serialize(async () => {
      return (await this.request("describeApi", [])) as Record<string, string>;
    });
  }

  async exportData(opts?: { fresh?: boolean }): Promise<ExportedData> {
    const cached = (): ExportedData | undefined => {
      if (
        !opts?.fresh &&
        this.exportCache &&
        Date.now() - this.exportCache.at < config.exportCacheMs
      ) {
        log.debug("extension", "exportData served from cache");
        return this.exportCache.data;
      }
      return undefined;
    };
    const hit = cached();
    if (hit) return hit;
    return this.serialize(async () => {
      // A read queued behind another export reuses the result it just cached.
      const queuedHit = cached();
      if (queuedHit) return queuedHit;
      log.info("extension", "Calling exportData");
      const start = Date.now();
      const data = (await this.request("exportData", [
        { key: this.requireApiKey() },
      ])) as ExportedData;
      log.info("extension", `exportData completed in ${Date.now() - start}ms`);
      this.exportCache = { data, at: Date.now() };
      return data;
    });
  }

  async updateAccount(
    accountId: string,
    data: Record<string, unknown>,
    force?: boolean,
  ): Promise<void> {
    await this.serialize(async () => {
      log.info(
        "extension",
        `Calling updateAccount for ${accountId}${force ? " (force)" : ""}`,
      );
      const opts: { key: string; force?: string } = { key: this.requireApiKey() };
      if (force) opts.force = "true";
      await this.request("updateAccount", [accountId, data, opts]);
    });
    this.invalidateCache();
  }

  private async restoreCall(method: WireMethod, payload: unknown): Promise<void> {
    await this.serialize(async () => {
      log.info("extension", `Calling ${method}`);
      await this.request(method, [payload, { key: this.requireApiKey() }]);
    });
    this.invalidateCache();
  }

  async restoreCurrentFinances(state: unknown): Promise<void> {
    await this.restoreCall("restoreCurrentFinances", state);
  }

  async restorePlans(plans: unknown[]): Promise<void> {
    await this.restoreCall("restorePlans", plans);
  }

  /** Re-reads the plans and writes `plans` as one entry on the operation
   * chain, so neither a hand-over to another instance nor another operation
   * of this one can run between the conflict check and the write. */
  async restorePlansIfUnchanged(read: unknown[], plans: unknown[]): Promise<void> {
    await this.serialize(async () => {
      const key = this.requireApiKey();
      const data = (await this.request("exportData", [{ key }])) as ExportedData;
      const changes = planChanges(read, Array.isArray(data.plans) ? data.plans : []);
      if (changes.length > 0) throw planConflictError(changes);
      log.info("extension", "Calling restorePlans");
      await this.request("restorePlans", [plans, { key }]);
    });
    this.invalidateCache();
  }

  async restoreProgress(progress: unknown): Promise<void> {
    await this.restoreCall("restoreProgress", progress);
  }

  async restoreSettings(settings: unknown): Promise<void> {
    await this.restoreCall("restoreSettings", settings);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.notifyState();
    this.yieldPeer?.terminate();
    this.dropConnection("server shutting down");
    if (this.wss) {
      log.info("extension", "Closing WebSocket server");
      await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
      this.wss = null;
    }
  }
}
