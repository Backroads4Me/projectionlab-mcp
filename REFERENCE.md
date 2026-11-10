# Technical reference

For developers and advanced users. Everyday use needs none of it; the
[README](README.md) covers setup.

## How it works

ProjectionLab has no REST API, so the server reaches its browser-side `window.projectionlabPluginAPI` over a localhost WebSocket that a browser-side executor connects out to: the **extension** for normal use, or a pasted **bootstrap snippet** for a zero-install test. See **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)** for the full architecture: the bridge design, wire protocol, extension internals, and safety model.

## Adding the server to your MCP host

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

## Agent instructions

The server carries its own instructions for the agents that use it, so no per-host prompt setup is needed:

- **Server instructions**, sent in the MCP initialize result. Hosts that surface them give the model the core rules: check the connection first, the read-only/dry-run/confirm workflow, privacy.
- **The `projectionlab://guide` resource**, the full agent guide: setup walkthrough for each failed connection check, which tool answers which question, the change workflow, and privacy rules. `projectionlab_check_connection` points agents to it.
- **The `projectionlab` skill** at [`skills/projectionlab/SKILL.md`](skills/projectionlab/SKILL.md), the same guide in the Agent Skills format, for hosts that load skills (copy the folder into the host's skills directory).

## Building from source

```bash
git clone https://github.com/Backroads4Me/projectionlab-mcp.git
cd projectionlab-mcp
npm install
npm run build
cd extension && npm install && npm run build && cd ..
```

Save the Plugin API key as `PL_API_KEY=...` in `~/.projectionlab-mcp/.env`
(see [Manual setup](MANUAL-SETUP.md) for where to find it). Register
`node /absolute/path/to/projectionlab-mcp/dist/index.js` with your MCP host
instead of `npx -y projectionlab-mcp`, and restart the host; on first start the
server creates the token at `~/.projectionlab-mcp/ws-token`. Load the built
extension from `extension/dist/chromium` or `extension/dist/firefox`, enter
port `8788` and that token on its options page, then run
`projectionlab_check_connection`.

## Configuration

Each setting is read from the first of these that sets it:

1. The `env` block of the server entry in the MCP host's config.
2. `~/.projectionlab-mcp/.env`, shared by every MCP host on the machine.
3. `.env` at the package root, for a development checkout (copy `.env.example`).

The server starts without `PL_API_KEY` so it can tell the agent what is missing; tools that need the key return `API_KEY_MISSING` until it is set.

## Environment variables

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

## Available tools

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
| `projectionlab_delete_plan` | Delete a plan by exact ID; refuses the last plan (dry-run by default) | Yes |
| `projectionlab_list_snapshots` | List saved pre-mutation snapshots | No |
| `projectionlab_diff` | Field-level changes between a snapshot and another snapshot or the live data, or between two plans (`planA` and `planB`) | No |
| `projectionlab_restore_current_finances` | Restore Current Finances from snapshot | Yes |
| `projectionlab_restore_plans` | Restore Plans from snapshot | Yes |
| `projectionlab_restore_progress` | Restore Progress from snapshot | Yes |
| `projectionlab_restore_settings` | Restore Settings from snapshot | Yes |
| `projectionlab_rollback` | Roll back to a previous snapshot | Yes |

## Resources

| URI | Description |
|---|---|
| `projectionlab://plan-data` | Full export of all plans/finances/progress/settings (refreshed per access) |
| `projectionlab://summary` | High-level snapshot: net worth, account breakdown, plan count |
| `projectionlab://knowledge` | Curated ProjectionLab data-model + FIRE/tax reference (static) |
| `projectionlab://data-model` | Field meanings, units, and allowed values for `listPaths` writes, version-stamped to ProjectionLab 4.6.0 (static) |
| `projectionlab://guide` | Agent guide: setup walkthrough, tool selection, change workflow, privacy rules (static) |

## Prompts

| Prompt | Purpose |
|---|---|
| `analyze-plan` | Structured analysis: cash flow, tax, risk, withdrawal, estate |
| `compare-plans` | Side-by-side comparison of two plans |
| `optimize-tax` | Roth conversion / bracket / IRMAA / gain-harvesting review |
| `review-assumptions` | Stress-test returns, inflation, healthcare, longevity |

## Safety model

Write operations (`update_*`, `restore_*`, `clone_plan`, `delete_plan`) default to **dry-run mode**. Pass `confirm: true` to execute. Before any confirmed mutation, the server automatically snapshots the affected data section to disk so you can roll back with `projectionlab_rollback`. Writes are disabled entirely unless `PL_READ_ONLY=false`.

Every write that replaces the plans array re-reads the plans just before writing and refuses with `PLAN_CONFLICT` if any plan was added, removed, or saved in ProjectionLab since the tool read them, so an edit made in the ProjectionLab UI is never silently overwritten. `projectionlab_update_plan_section` also returns a `planVersion` in its dry run; pass it back as `expectedPlanVersion` when confirming to refuse the write if the plan was saved after the preview.

Plan reads hide secret values: a secret-named field (`apiKey`, `token`, `password`, …) comes back as `[REDACTED]`. A payload for `projectionlab_update_plan_section` or any `restore_*` tool that still holds that sentinel under a secret-named key is refused with `INVALID_INPUT`, dry runs included, naming the offending dot paths. Supply the real value, or change single fields with `projectionlab_update_plan_event` or `projectionlab_update_plan_settings`, which patch by path and never round-trip hidden values.

`projectionlab_update_plan_section` also refuses `sectionData` that does not match the section's current container shape (array for milestones, `{ events: [...] }` for event sections, plain object for `variables`, `montecarlo` and `withdrawalStrategy`), so a wrong or omitted payload can never delete a section or change its type.

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

## Evaluating plan impact

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

## Secret handling

The Plugin API key stays on your computer: it is never logged, and the browser side never stores it. The WebSocket accepts only local connections that present a shared token. See [Security in HOW-IT-WORKS.md](HOW-IT-WORKS.md#4-security) for the details.

## After code changes

This server runs over stdio; the host process keeps compiled `dist/` in memory.

```bash
npm run build
# Then restart your MCP host
projectionlab_check_connection  # verify before other operations
```

With the extension the browser side reconnects on its own, so you only restart the MCP host. If you change extension source, rebuild it (`cd extension && npm run build`) and reload it in the browser.
