# How the ProjectionLab MCP Works

Here is a breakdown of exactly how the ProjectionLab Model Context Protocol (MCP) server works, from the underlying problem it solves to the step-by-step data flow.

## 1. The Core Problem It Solves

ProjectionLab is a purely client-side application. All calculations and state management live within the browser tab; there is no REST API or backend webhook endpoint for an agent to talk to. The only programmatic access is a local JavaScript object (`window.projectionlabPluginAPI`) exposed when a user enables Plugins in their settings.

Because an LLM agent (like Claude Code) runs as a CLI tool in your terminal, it cannot directly call a JavaScript object inside your browser. This MCP server bridges that gap.

## 2. The Architecture

The server speaks the Model Context Protocol (MCP) over `stdio` to Claude Code — it appears as a set of tools (`projectionlab_update_account`, `projectionlab_export_data`, …) and resources. To reach the Plugin API, everything above the bridge depends only on the `Bridge` interface (`src/bridge.ts`), implemented by `ExtensionBridge`:

The server opens a WebSocket listener on `127.0.0.1:<PL_WS_PORT>`. A browser-side **executor** — either the packaged browser extension or a pasted bootstrap snippet — connects *out* to it, receives command frames, calls `window.projectionlabPluginAPI` in the real, already-logged-in ProjectionLab tab, and returns results. No second browser, no second login.

### The wire protocol

`src/types/wire.ts` is the contract shared by the server and every executor:

- The executor connects and sends a `hello` frame with a shared token and protocol version. The server validates the `Origin` header (extension or app origin only), checks the token, and replies `helloAck` — or closes with code `4001` (auth), `4002` (version), or `4003` (a newer executor replaced this one).
- Requests are `{ id, method, params }`; responses are `{ id, ok, result | error }`. Methods map directly to Plugin API calls plus `describeApi`/`waitForApi`.
- A ~20 s `ping`/`pong` heartbeat keeps the connection healthy (and keeps a Manifest V3 service worker from being suspended).

### The browser extension

Manifest V3, in `extension/`. A background service worker owns the WebSocket (with reconnect/backoff and an `alarms`-based wake so it recovers even after the worker is suspended). Because content scripts run in an isolated world and cannot see `window.projectionlabPluginAPI`, a **page script is injected into the MAIN world** and bridged to the content script via nonce-scoped `postMessage`. It routes commands to the ProjectionLab tab (auto-opening one if none is present) and executes them against the Plugin API. Chrome/Edge/Brave use the service-worker manifest; Firefox (≥ 128, for MAIN-world `scripting`) uses an event-page manifest.

### The bootstrap snippet

`src/bootstrap.ts` generates a self-contained snippet (returned by the `projectionlab_get_bootstrap` tool) that plays the same executor role from the page's console — same protocol, same methods. It's the zero-install path and a handy debugging harness, but it lives only until the tab reloads.

## 3. Step-by-Step Execution Lifecycle

### A. Initialization

The server starts listening immediately. Tool calls made before an executor connects return an actionable `EXTENSION_NOT_CONNECTED` error. Once the extension (or snippet) connects and authenticates, requests flow.

### B. Read Operations (`export_data`, `get_summary`, `describe_schema`)

1. The MCP tool validates input with Zod.
2. The bridge sends an `exportData({ key })` request over the WebSocket to the executor, which calls it in the browser context.
3. The browser serializes your financial state to JSON and returns it.
4. The server shapes the payload (schema stripping, net-worth calc, redaction) and returns it to Claude. A short-lived export cache avoids re-serializing hundreds of KB on every read; every write invalidates it.

### C. Write Operations & Safety Flow (`update_*`, `restore_*`)

Because the Plugin API relies on **full state replacements** rather than surgical patches, the server enforces a multi-layered safety net:

1. **Dry-Run by Default:** without `confirm: true`, the tool returns a structured diff preview instead of mutating anything.
2. **Auto-Snapshotting:** on `confirm: true`, the `SnapshotManager` requests a fresh export, extracts the section about to be replaced, and writes it to a local JSON file with an ID and timestamp.
3. **Execution:** only then does the bridge inject the `updateAccount()` / `restore*()` call.
4. **Verification:** the server re-reads and confirms the change landed.

### D. Rollbacks & Recovery

`projectionlab_rollback` reads a saved snapshot and pipes it back through the matching `restore_*` method, reverting the tab's state. A pre-rollback snapshot is also saved.

## 4. Security

- The WebSocket binds to `127.0.0.1` only, validates the `Origin` header, and requires a shared token — this blocks both other local processes and JavaScript on arbitrary web pages from driving your financial data.
- The Plugin API key stays server-side (`.env`) and is passed per request; the executor never stores it.
- Snapshots and full exports pass through a redactor before touching disk or leaving the process.

## Local Restart Workflow

This server runs over stdio, so the host process keeps the compiled `dist/` code in memory after startup. Rebuilding with `npm run build` updates files on disk but does not hot-reload the running server.

After source changes:

1. Run `npm run build`.
2. Restart the MCP host so it launches a fresh `dist/index.js`.
3. Re-run `projectionlab_check_connection` before any other tool.

For the extension transport, the browser side reconnects automatically; you do not need to reload the extension after a server restart.
