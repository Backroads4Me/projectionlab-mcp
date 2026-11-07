# ProjectionLab MCP Server

**Talk to an AI assistant about your retirement plan, and let it read and update your numbers in [ProjectionLab](https://projectionlab.com) for you.**

ProjectionLab is a retirement and financial-planning app. This project connects it to an AI assistant (like Claude, or any assistant that supports the "MCP" standard; more on that below) so you can ask questions in plain English and get real answers based on *your* actual plan:

- *"Am I on track to retire at 60?"*
- *"What happens to my plan if the market returns 2% less than I assumed?"*
- *"Bump my planned travel spending to $12,000 a year and show me the effect."*

The assistant can look at your plan, walk through the tradeoffs with you, and, only when you say so, make changes for you. Every change is previewed before it happens and can be undone.

---

## Is this for me?

You'll get value from this if:

- You already use (or want to use) **ProjectionLab** for retirement planning, and
- You use an **AI assistant that supports MCP** (see below).

You do **not** need to be a programmer. The recommended path is to let your assistant do the technical setup for you. You'll mostly be answering a few questions and clicking a couple of buttons in your browser.

> **A note on trust and safety:** This tool can *change* your financial plan, so it's built to be careful. It starts in **read-only mode** (it can look but not touch). Nothing is changed without showing you a preview first, and every change is backed up so it can be reversed. Your ProjectionLab API key stays on your own computer and is never sent anywhere.

### What's "MCP"? Which assistants work?

**MCP** (Model Context Protocol) is an open standard that lets AI assistants safely connect to outside tools. This project is an MCP "server," so it works with **any** assistant or app that supports MCP, so you are not locked into one company. Popular options include **Claude Desktop** and **Claude Code**, and a growing list of other MCP-compatible assistants and editors. If your assistant can "add an MCP server," it can use this.

*(The author uses Claude Code, but that's just a preference. Pick whatever you like.)*

---

## What you'll need

1. A **ProjectionLab account** with **Plugins enabled**. In ProjectionLab, go to **Account Settings → Plugins**, turn plugins on, and copy your **Plugin API Key** (a long code; keep it handy, since you'll give it to your assistant).
2. An **AI assistant that supports MCP** (see above).
3. A **web browser** you already use: Chrome, Edge, Brave, or Firefox (version 128 or newer).
4. **Node.js** installed on your computer (version 20 or newer). If you don't have it, your assistant can help you install it, or download it from [nodejs.org](https://nodejs.org).

---

## The easy way: let your assistant set it up

Open your AI assistant and give it this instruction (copy-paste it as-is):

> Please set up the ProjectionLab MCP server for me from
> `https://github.com/Backroads4Me/projectionlab-mcp`.
> Follow the "For your AI assistant" section of its README. I'm not technical, so
> walk me through anything you need from me (like my ProjectionLab Plugin API key
> and loading the browser extension) one step at a time. Keep it in read-only
> mode until I say otherwise.

Your assistant will download the project, install it, and hand you a couple of short, click-by-click steps in your browser (loading a small helper extension and pasting in a code). When it's done, just start asking questions about your plan.

If anything gets stuck, tell your assistant what you see on screen; it can troubleshoot from there.

---

## For your AI assistant

*(This section is written for the AI agent doing the install. If you're a person reading this, you can skip it. Your assistant follows these steps.)*

You are setting this up for a **non-technical user**. Explain each thing you need from them in plain language, one step at a time, and never ask them to do something you can do yourself.

**1. Get the user's Plugin API key.** Ask them to open ProjectionLab → Account Settings → Plugins, enable plugins, and copy their **Plugin API Key**. Do **not** invent one, and never print, log, or commit it.

**2. Store the key.** Write it to `~/.projectionlab-mcp/.env` as the line `PL_API_KEY=...` and make the file readable only by the user (`chmod 600`). Every MCP host on the machine reads this file, so the key lives in one place. Do not repeat the key back to the user. Writes stay disabled by default; do not set `PL_READ_ONLY=false` until the user has seen the tool working and explicitly asks.

**3. Register the server with the user's MCP host.** The server runs with `npx`, which needs Node.js 20 or newer:
```json
{
  "mcpServers": {
    "projectionlab": {
      "command": "npx",
      "args": ["-y", "projectionlab-mcp"]
    }
  }
}
```
The config location varies by host; see [Adding the server to your MCP host](#adding-the-server-to-your-mcp-host) for common ones. Have the user restart the host so it starts the server. On first start the server creates the browser connection token at `~/.projectionlab-mcp/ws-token`.

**4. Connect the browser.** The server reaches ProjectionLab through the user's own browser. Pick the path that fits:

- **Recommended: the browser extension** (persists across restarts). Download the zip for the user's browser from the [latest release](https://github.com/Backroads4Me/projectionlab-mcp/releases/latest) and unzip it. Then walk the user through loading it (this is a click-by-click browser task; describe exactly what they'll see):
  - **Chrome / Edge / Brave:** open `chrome://extensions`, turn on "Developer mode" (top-right), click "Load unpacked", and choose the unzipped Chromium folder.
  - **Firefox (128+):** open `about:debugging` → "This Firefox" → "Load Temporary Add-on", and choose `manifest.json` in the unzipped Firefox folder. Firefox removes temporary add-ons when it restarts.
  Then have them open the extension's **options page** and enter the WebSocket **port** (default `8788`) and the **shared token** from `~/.projectionlab-mcp/ws-token`.

- **Quick alternative: no install.** Call the `projectionlab_get_bootstrap` tool, then have the user paste the returned snippet into their ProjectionLab tab's developer console (F12 → Console). It works the same way but must be re-pasted if they reload the page. Good for a first test drive.

**5. Verify.** Have the user open [ProjectionLab](https://app.projectionlab.com), log in, and confirm plugins are enabled. Then call `projectionlab_check_connection`; it should report all checks passing. Do this before any other tool call.

**6. Enabling changes (writes).** Leave everything in dry-run/read-only until the user explicitly asks to make changes. When they do: set `PL_READ_ONLY=false` in `~/.projectionlab-mcp/.env` or the host's `env` block, restart the host, and remember that every write still previews first (`confirm: true` required) and auto-snapshots so it can be rolled back. Reassure the user of this before the first change.

---

## Technical reference

The rest of this document is for developers or advanced users. Everyday use needs none of it.

### How it works

ProjectionLab has no REST API, so the server reaches its browser-side `window.projectionlabPluginAPI` over a localhost WebSocket that a browser-side executor connects out to: the **extension** for normal use, or a pasted **bootstrap snippet** for a zero-install test. See **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)** for the full architecture: the bridge design, wire protocol, extension internals, and safety model.

### Adding the server to your MCP host

The server is a standard stdio MCP server started with `npx -y projectionlab-mcp`. Put the key in `~/.projectionlab-mcp/.env` (see [Configuration](#configuration)) so no host config holds a secret.

**Claude Code:**
```bash
claude mcp add --scope user projectionlab -- npx -y projectionlab-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and other hosts that use the `mcpServers` JSON format:
```json
{
  "mcpServers": {
    "projectionlab": {
      "command": "npx",
      "args": ["-y", "projectionlab-mcp"]
    }
  }
}
```

**Hermes Agent** (`config.yaml` of the profile):
```yaml
mcp_servers:
  projectionlab:
    command: npx
    args: ["-y", "projectionlab-mcp"]
    enabled: true
```

Only one server instance can hold the WebSocket port. When a second host starts the server while another instance holds it, the second retries every few seconds and takes over when the first exits; `projectionlab_check_connection` explains the state in the meantime. To run both at once, give one of them its own `PL_WS_PORT` in its `env` block.

### Agent instructions

The server carries its own instructions for the agents that use it, so no per-host prompt setup is needed:

- **Server instructions**, sent in the MCP initialize result. Hosts that surface them give the model the core rules: check the connection first, the read-only/dry-run/confirm workflow, privacy.
- **The `projectionlab://guide` resource**, the full agent guide: setup walkthrough for each failed connection check, which tool answers which question, the change workflow, and privacy rules. `projectionlab_check_connection` points agents to it.
- **The `projectionlab` skill** at [`skills/projectionlab/SKILL.md`](skills/projectionlab/SKILL.md), the same guide in the Agent Skills format, for hosts that load skills (copy the folder into the host's skills directory).

### Manual setup from source

```bash
npm install
npm run build
cd extension && npm install && npm run build   # build the extension
```

Register `node /absolute/path/to/projectionlab-mcp/dist/index.js` with your MCP host, load the built extension (`extension/dist/chromium` or `extension/dist/firefox`), configure its port + token on the options page, then run `projectionlab_check_connection`.

### Configuration

Each setting is read from the first of these that sets it:

1. The `env` block of the server entry in the MCP host's config.
2. `~/.projectionlab-mcp/.env`, shared by every MCP host on the machine.
3. `.env` at the package root, for a development checkout (copy `.env.example`).

The server starts without `PL_API_KEY` so it can tell the agent what is missing; tools that need the key return `API_KEY_MISSING` until it is set.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PL_API_KEY` | Yes | - | ProjectionLab Plugin API key; tools that reach the plan fail until it is set |
| `PL_WS_PORT` | No | `8788` | Localhost WebSocket port |
| `PL_WS_TOKEN` | No | auto-generated | Shared auth token; if unset, generated and saved to `~/.projectionlab-mcp/ws-token` |
| `PL_APP_URL` | No | `https://app.projectionlab.com` | ProjectionLab app URL |
| `PL_API_READY_TIMEOUT_MS` | No | `30000` | Timeout waiting for Plugin API to attach |
| `PL_EXPORT_CACHE_MS` | No | `90000` | How long a full export may be served from cache (writes always invalidate) |
| `PL_PRETTY_JSON` | No | `false` | Pretty-print JSON output (uses ~25–40% more tokens) |
| `PL_READ_ONLY` | No | `true` | Write/mutation tools are disabled unless this is exactly `false` |
| `PL_SNAPSHOT_DIR` | No | `~/.projectionlab-mcp/snapshots` | Directory for pre-mutation snapshots |
| `LOG_LEVEL` | No | `info` | Log verbosity (`debug`, `info`, `warn`, `error`) |

### Available tools

| Tool | Description | Mutates |
|---|---|---|
| `projectionlab_check_connection` | Verify browser + API connectivity | No |
| `projectionlab_get_bootstrap` | Return a console snippet to connect a ProjectionLab tab | No |
| `projectionlab_describe_plugin_api` | Describe the available Plugin API surface | No |
| `projectionlab_describe_schema` | Describe the data schema (plan names, account IDs) | No |
| `projectionlab_export_data` | Export full plan state as JSON | No |
| `projectionlab_get_summary` | Inventory Current Finances balances and current net worth (not projected outcomes) | No |
| `projectionlab_get_plan` | Retrieve a single plan | No |
| `projectionlab_get_plan_section` | Retrieve a plan section; supports event/path filters and typed field-path listing | No |
| `projectionlab_get_plan_settings` | List discrete plan settings as path-addressable values | No |
| `projectionlab_get_current_finances` | Get Current Finances or list typed paths for one account | No |
| `projectionlab_update_account` | Patch one Current Finances account by top-level fields or nested dot paths | Yes |
| `projectionlab_update_plan_event` | Patch one event by top-level fields or nested dot paths | Yes |
| `projectionlab_update_plan_settings` | Patch existing assumptions, Monte Carlo, or withdrawal settings by path | Yes |
| `projectionlab_update_plan_section` | Replace a whole section of a plan (dry-run by default) | Yes |
| `projectionlab_clone_plan` | Copy a plan to a new, named plan for what-if scenarios | Yes |
| `projectionlab_list_snapshots` | List saved pre-mutation snapshots | No |
| `projectionlab_restore_current_finances` | Restore Current Finances from snapshot | Yes |
| `projectionlab_restore_plans` | Restore Plans from snapshot | Yes |
| `projectionlab_restore_progress` | Restore Progress from snapshot | Yes |
| `projectionlab_restore_settings` | Restore Settings from snapshot | Yes |
| `projectionlab_rollback` | Roll back to a previous snapshot | Yes |

### Resources

| URI | Description |
|---|---|
| `projectionlab://plan-data` | Full export of all plans/finances/progress/settings (refreshed per access) |
| `projectionlab://summary` | High-level snapshot: net worth, account breakdown, plan count |
| `projectionlab://knowledge` | Curated ProjectionLab data-model + FIRE/tax reference (static) |
| `projectionlab://guide` | Agent guide: setup walkthrough, tool selection, change workflow, privacy rules (static) |

### Prompts

| Prompt | Purpose |
|---|---|
| `analyze-plan` | Structured analysis: cash flow, tax, risk, withdrawal, estate |
| `compare-plans` | Side-by-side comparison of two plans |
| `optimize-tax` | Roth conversion / bracket / IRMAA / gain-harvesting review |
| `review-assumptions` | Stress-test returns, inflation, healthcare, longevity |

### Safety model

Write operations (`update_*`, `restore_*`, `clone_plan`) default to **dry-run mode**. Pass `confirm: true` to execute. Before any confirmed mutation, the server automatically snapshots the affected data section to disk so you can roll back with `projectionlab_rollback`. Writes are disabled entirely unless `PL_READ_ONLY=false`.

Every write that replaces the plans array re-reads the plans just before writing and refuses with `PLAN_CONFLICT` if any plan was added, removed, or saved in ProjectionLab since the tool read them, so an edit made in the ProjectionLab UI is never silently overwritten. `projectionlab_update_plan_section` also returns a `planVersion` in its dry run; pass it back as `expectedPlanVersion` when confirming to refuse the write if the plan was saved after the preview.

For a small assumptions or strategy change, first call
`projectionlab_get_plan_settings` with the plan name. It returns the current
`variables`, `montecarlo`, and `withdrawalStrategy` values as dot paths with
their JSON types. Preview a path-level patch with
`projectionlab_update_plan_settings`, for example:

```json
{
  "planIdentifier": "Retire at 55",
  "section": "variables",
  "changes": {
    "showFutureDollars": true
  }
}
```

The update tool preserves sibling settings, rejects unknown paths and JSON type
changes, and still requires `"confirm": true` before it sends a mutation.
Advanced inflation, stock-growth, dividend-yield, bond-growth, and bond-yield
schedules expose both the complete ordered array and indexed control-point
fields, so one existing year or rate can be adjusted without replacing the
rest of the schedule.

Event forms use the same path workflow. Fetch one event with
`projectionlab_get_plan_section` using its `eventIdentifier` and
`"listPaths": true`, then pass selected paths to
`projectionlab_update_plan_event` as `pathChanges`. The older `patch` input
remains available for shallow top-level changes.

Current Finances accounts also support targeted discovery and nested patches.
Call `projectionlab_get_current_finances` with an exact `accountId` and
`"listPaths": true`, then pass selected paths to
`projectionlab_update_account` as `pathChanges`. The legacy `data` input
remains available for top-level fields. Dry runs validate the account and
return before/after values as a safety diff; confirmed no-ops do not create a
snapshot or send a mutation.

### Evaluating plan impact

Projected ending net worth and Chance of Success are the primary outcome
metrics for comparing a plan before and after a change. Current Finances
balances are inputs. Mutation before/after values verify that the requested
input changed, but they do not measure the plan's financial impact.

ProjectionLab's Plugin API currently exposes plan definitions and simulation
settings, but not a supported method to recalculate and retrieve projected
ending net worth or a completed Chance of Success result. After a confirmed
mutation, re-read the targeted input through MCP for verification, then
recalculate the plan and run Chance of Success in the ProjectionLab UI before
drawing a conclusion.

### Secret handling

The Plugin API key stays on your computer: it is never logged, and the browser side never stores it. The WebSocket accepts only local connections that present a shared token. See [Security in HOW-IT-WORKS.md](HOW-IT-WORKS.md#4-security) for the details.

### After code changes

This server runs over stdio; the host process keeps compiled `dist/` in memory.

```bash
npm run build
# Then restart your MCP host
projectionlab_check_connection  # verify before other operations
```

With the extension the browser side reconnects on its own, so you only restart the MCP host. If you change extension source, rebuild it (`cd extension && npm run build`) and reload it in the browser.
