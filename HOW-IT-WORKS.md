# How the ProjectionLab MCP Works

Here is a breakdown of exactly how the ProjectionLab Model Context Protocol (MCP) server works, from the underlying problem it solves to the step-by-step data flow.

## 1. The Core Problem It Solves

ProjectionLab exposes its supported automation surface through a JavaScript object (`window.projectionlabPluginAPI`) inside the logged-in browser tab rather than through a public REST API or webhook endpoint.

Because an MCP host runs outside that page, it cannot directly call a JavaScript object inside the browser. This MCP server bridges that gap.

## 2. The Architecture

The server speaks the Model Context Protocol (MCP) over `stdio` to its host and exposes tools (`projectionlab_update_account`, `projectionlab_export_data`, …), resources, and prompts. Everything above the browser transport depends only on the `Bridge` interface (`src/bridge.ts`), which `ExtensionBridge` implements.

The server opens a WebSocket listener on `127.0.0.1:<PL_WS_PORT>`. A browser-side **executor** (either the packaged browser extension or a pasted bootstrap snippet) connects *out* to it, receives command frames, calls `window.projectionlabPluginAPI` in the real, already-logged-in ProjectionLab tab, and returns results. No second browser, no second login.

### The wire protocol

`src/types/wire.ts` is the contract shared by the server and every executor:

- The executor connects and sends a `hello` frame with a shared token and protocol version. The server validates the `Origin` header (extension or app origin only), checks the token, and replies `helloAck`, or closes with code `4001` (auth), `4002` (version), or `4003` (a newer executor replaced this one).
- Requests are `{ id, method, params }`; responses are `{ id, ok, result | error }`. Methods map directly to Plugin API calls plus `describeApi`/`waitForApi`.
- A ~20 s `ping`/`pong` heartbeat keeps the connection healthy (and keeps a Manifest V3 service worker from being suspended).

### The browser extension

Manifest V3, in `extension/`. A background service worker owns the WebSocket, reconnects with exponential backoff, and uses an `alarms` wake after suspension. For each request it locates a ProjectionLab tab (opening one in the background when configured to do so) and uses `scripting.executeScript` to run the operation directly in the page's **MAIN world**, where `window.projectionlabPluginAPI` is visible. The structured result returns through the scripting API without a content-script relay. Chrome/Edge/Brave use the service-worker manifest; Firefox 140 or newer uses an event-page manifest with MAIN-world scripting support.

### The bootstrap snippet

`src/bootstrap.ts` generates a self-contained snippet (returned by the `projectionlab_get_bootstrap` tool) that plays the same executor role from the page's console, with the same protocol and methods. It's the zero-install path and a handy debugging harness, but it lives only until the tab reloads.

## 3. Step-by-Step Execution Lifecycle

### A. Initialization

The server starts listening immediately. Tool calls made before an executor connects return an actionable `EXTENSION_NOT_CONNECTED` error. Once the extension (or snippet) connects and authenticates, requests flow.

### B. Read Operations (`export_data`, `get_plan`, `get_summary`, …)

1. The MCP tool validates input with Zod.
2. The bridge sends an `exportData({ key })` request over the WebSocket to the executor, which calls it in the browser context.
3. The browser serializes your financial state to JSON and returns it.
4. The server selects or summarizes the requested data, redacts secrets where appropriate, and returns it to the MCP host. Results above the inline size limit are written to a protected local export file and returned as a file pointer. A short-lived export cache avoids re-serializing the complete state on every read; every write invalidates it.

### C. Write Operations & Safety Flow (`update_*`, `restore_*`, `clone_plan`)

The Plugin API provides a targeted `updateAccount` operation for Current Finances and whole-area restore operations (`restorePlans` and the others) for everything else. Plan edits, including `clone_plan`, are built as a complete new plans array and written with `restorePlans`. The server builds safe patches on top of those primitives and enforces a multi-layered safety net:

1. **Dry-Run by Default:** without `confirm: true`, the tool returns a structured diff preview instead of mutating anything.
2. **Fresh State:** the tool requests an uncached export and validates the requested change against the current data.
3. **Auto-Snapshotting:** on `confirm: true`, the tool passes the affected current section to `SnapshotManager`, which writes a restore-safe local JSON snapshot with an ID and timestamp.
4. **Conflict Check:** because `restorePlans` replaces every plan, a plan write re-reads the plans just before writing and refuses with `PLAN_CONFLICT` if any plan was added, removed, or saved in ProjectionLab since the tool read them (`assertPlansUnchanged` in `src/planVersion.ts`). `projectionlab_update_plan_section` also accepts the dry run's `planVersion` as `expectedPlanVersion` and refuses if the plan was saved after the preview.
5. **Execution:** only then does the bridge call `updateAccount()` or the appropriate `restore*()` method.
6. **Verification:** the tool performs a fresh re-read and checks that the requested change landed. A verification failure is reported with the snapshot retained for recovery.

### D. Rollbacks & Recovery

`projectionlab_rollback` reads a saved snapshot and pipes it back through the matching `restore_*` method, reverting the tab's state. A pre-rollback snapshot is also saved.

## 4. Security

- The Plugin API key is read only from the MCP host's `env` block, `~/.projectionlab-mcp/.env`, or a development `.env` (gitignored). It is never logged. It stays in the server process and is passed to the page only as an argument to Plugin API calls; the extension does not persist it.
- The WebSocket binds to `127.0.0.1` only, accepts only the ProjectionLab app and browser-extension origins, and requires a shared token (`PL_WS_TOKEN`, or auto-generated at `~/.projectionlab-mcp/ws-token` with owner-only permissions), so neither other local processes nor arbitrary web pages can drive your data. Native clients without an `Origin` header still need the token.
- Snapshots scrub the literal Plugin API key while preserving restore data. Exports, plan reads, and the `plan-data` resource additionally redact secret-named fields before they are returned or written to disk.
- Read-only mode (the default; any `PL_READ_ONLY` other than `false`) rejects mutation tools before they read, snapshot, or write plan data.
- The published npm package ships only `dist/`, the agent skill, and docs (the `files` allowlist in `package.json`), so source and `.env` files are never distributed.
