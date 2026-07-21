import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { buildBootstrapSnippet } from "./bootstrap.js";
import type { Bridge, ConnectionStatus } from "./bridge.js";
import { config } from "./config.js";
import { ProjectionLabError } from "./errors.js";
import { log } from "./logger.js";
import type { ExportedData } from "./types/projectionlab.js";
import {
  CLOSE_CODES,
  HEARTBEAT_INTERVAL_MS,
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
const REQUEST_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class ExtensionBridge implements Bridge {
  private wss: WebSocketServer | null = null;
  private conn: WebSocket | null = null;
  private connExecutor = "";
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private heartbeat: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  private readonly token: string;

  // Serialize all operations and cache the last full export until a write
  // invalidates it.
  private opChain: Promise<unknown> = Promise.resolve();
  private exportCache: { data: ExportedData; at: number } | null = null;

  constructor() {
    this.token = config.wsToken ?? this.loadOrCreateToken();
    this.listen();
  }

  private loadOrCreateToken(): string {
    const file = join(dirname(config.snapshotDir), "ws-token");
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    } catch {
      // No token yet.
    }
    const token = randomBytes(24).toString("base64url");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, token + "\n", { mode: 0o600 });
    log.info("extension", `Generated WebSocket token at ${file}`);
    return token;
  }

  private listen(): void {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: config.wsPort,
    });
    this.wss.on("listening", () => {
      log.info("extension", `Listening on ws://127.0.0.1:${config.wsPort}`);
    });
    this.wss.on("error", (err) => {
      log.error(
        "extension",
        `WebSocket server error: ${err.message}. ` +
          (err.message.includes("EADDRINUSE")
            ? `Port ${config.wsPort} is taken — set PL_WS_PORT to a free port.`
            : ""),
      );
    });
    this.wss.on("connection", (ws, req) => {
      const origin = req.headers.origin;
      if (!originAllowed(origin)) {
        log.warn("extension", `Rejected connection from origin ${origin}`);
        ws.close(CLOSE_CODES.AUTH_FAILED, "origin not allowed");
        return;
      }
      this.awaitHello(ws, origin ?? "(no origin)");
    });
  }

  /** New sockets must send a valid hello before anything else. */
  private awaitHello(ws: WebSocket, origin: string): void {
    const timer = setTimeout(() => {
      ws.close(CLOSE_CODES.AUTH_FAILED, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    ws.once("message", (raw) => {
      clearTimeout(timer);
      let hello: ClientFrame;
      try {
        hello = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        ws.close(CLOSE_CODES.AUTH_FAILED, "malformed hello");
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
      this.adopt(ws, hello.executor);
    });
  }

  /** Promote an authenticated socket to the active connection (newest wins). */
  private adopt(ws: WebSocket, executor: string): void {
    if (this.conn && this.conn !== ws) {
      log.info("extension", `Replacing ${this.connExecutor} with ${executor}`);
      this.conn.close(CLOSE_CODES.REPLACED, "replaced by newer connection");
    }
    this.conn = ws;
    this.connExecutor = executor;
    log.info("extension", `Executor connected: ${executor}`);
    ws.send(JSON.stringify({ type: "helloAck", protocolVersion: PROTOCOL_VERSION }));

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
  }

  private onFrame(ws: WebSocket, raw: unknown): void {
    if (this.conn !== ws) return;
    let frame: ClientFrame;
    try {
      frame = JSON.parse(String(raw)) as ClientFrame;
    } catch {
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
          "The ProjectionLab page did not respond in time — check the tab and try again",
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

  private dropConnection(reason: string): void {
    // Close the socket if it's still live — wss.close() waits for all
    // clients, so leaving it open would hang shutdown.
    try {
      this.conn?.terminate();
    } catch {
      // Already gone.
    }
    this.conn = null;
    this.connExecutor = "";
    this.awaitingPong = false;
    this.exportCache = null;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
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

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.catch(() => {});
    return next;
  }

  private request(
    method: WireMethod,
    params: unknown[],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const conn = this.conn;
    if (!conn) {
      throw new ProjectionLabError(
        "EXTENSION_NOT_CONNECTED",
        "No browser-side executor is connected",
        "Open your browser with the ProjectionLab bridge extension enabled (or paste the bootstrap snippet into the ProjectionLab tab's console)",
      );
    }
    const id = String(this.nextId++);
    const frame: RequestFrame = { type: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProjectionLabError(
            "TIMEOUT",
            `${method} timed out after ${timeoutMs}ms`,
            "The browser did not respond — check that the ProjectionLab tab is open and responsive",
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
      if (!this.conn) {
        result.errors.push(
          `EXTENSION_NOT_CONNECTED: No browser-side executor is connected to ws://127.0.0.1:${config.wsPort}. ` +
            "Open your browser with the ProjectionLab bridge extension enabled.",
        );
        return result;
      }
      result.browser = true;
      try {
        await this.request("waitForApi", [], config.apiReadyTimeoutMs + 5_000);
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
    if (
      !opts?.fresh &&
      this.exportCache &&
      Date.now() - this.exportCache.at < config.exportCacheMs
    ) {
      log.debug("extension", "exportData served from cache");
      return this.exportCache.data;
    }
    return this.serialize(async () => {
      log.info("extension", "Calling exportData");
      const start = Date.now();
      const data = (await this.request("exportData", [
        { key: config.apiKey },
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
      const opts: { key: string; force?: string } = { key: config.apiKey };
      if (force) opts.force = "true";
      await this.request("updateAccount", [accountId, data, opts]);
    });
    this.invalidateCache();
  }

  private async restoreCall(method: WireMethod, payload: unknown): Promise<void> {
    await this.serialize(async () => {
      log.info("extension", `Calling ${method}`);
      await this.request(method, [payload, { key: config.apiKey }]);
    });
    this.invalidateCache();
  }

  async restoreCurrentFinances(state: unknown): Promise<void> {
    await this.restoreCall("restoreCurrentFinances", state);
  }

  async restorePlans(plans: unknown[]): Promise<void> {
    await this.restoreCall("restorePlans", plans);
  }

  async restoreProgress(progress: unknown): Promise<void> {
    await this.restoreCall("restoreProgress", progress);
  }

  async restoreSettings(settings: unknown): Promise<void> {
    await this.restoreCall("restoreSettings", settings);
  }

  async close(): Promise<void> {
    this.dropConnection("server shutting down");
    if (this.wss) {
      log.info("extension", "Closing WebSocket server");
      await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
      this.wss = null;
    }
  }
}
