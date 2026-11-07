---
name: projectionlab
description: Use when working with a user's ProjectionLab retirement or financial plan through the projectionlab MCP server - reading plans, Current Finances, assumptions and withdrawal settings, answering retirement-readiness questions, comparing scenarios, or making plan changes the user asks for. Also use when the projectionlab tools fail to connect and the user needs setup help.
---

# ProjectionLab MCP

The `projectionlab` MCP server reads and edits a user's
[ProjectionLab](https://projectionlab.com) plan through the ProjectionLab Plugin
API. ProjectionLab has no REST API, so every call runs in the user's own
logged-in browser tab, relayed by a small browser extension over a localhost
WebSocket. If the browser side is not connected, no tool can reach the plan.

The server also serves this guide as the MCP resource `projectionlab://guide`.

## Start every session with a connection check

Call `projectionlab_check_connection` before any other ProjectionLab tool. It
returns `browser`, `pageLoaded`, `apiAvailable`, `apiKeyValid` and `errors`.
When everything is `true`, proceed. Otherwise fix the first failing item with
the user, one step at a time, then check again.

| Failing item | What it means | What to do with the user |
|---|---|---|
| `API_KEY_MISSING` in `errors` | The server has no Plugin API key | See "Setting the API key" |
| `browser: false`, port held by another instance | Another agent on this machine runs the server and has the extension | Wait for that agent to exit (this server takes over within about a minute), or give this one its own `PL_WS_PORT` and point the extension at it |
| `browser: false` otherwise | No extension or snippet is connected | See "Connecting the browser"; on Firefox after a restart, only reload the add-on |
| `pageLoaded: false` | No ProjectionLab tab is open | Ask the user to open https://app.projectionlab.com and log in |
| `apiAvailable: false` | Plugins are off, or the user is logged out | ProjectionLab -> Account Settings -> Plugins -> enable plugins |
| `apiKeyValid: false` | The key does not match the account | Ask the user to copy the key again from Account Settings -> Plugins |

### Setting the API key

The user copies the **Plugin API Key** from ProjectionLab -> Account Settings ->
Plugins. It goes in one of these places; the first one that sets it wins:

1. The `env` block of this server in the MCP host's config.
2. `~/.projectionlab-mcp/.env`, shared by every MCP host on the machine, as the
   line `PL_API_KEY=...`. Keep the file readable only by the user
   (`chmod 600`).

The MCP host must restart the server after the key changes. Never invent a key,
and never print, echo, log or store the key in a conversation, file or commit.
If you write the file for the user, do not repeat the value back.

### Connecting the browser

Recommended, persistent: the **ProjectionLab MCP Bridge** browser extension.

1. Download the zip for the user's browser (Chromium or Firefox) from the
   GitHub Releases page of https://github.com/Backroads4Me/projectionlab-mcp
   and unzip it.
2. Chrome, Edge or Brave: open `chrome://extensions`, enable **Developer mode**,
   choose **Load unpacked**, and select the unzipped folder. Firefox 128+: open
   `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
   and select `manifest.json` (Firefox removes temporary add-ons on restart).
3. Open the extension's options page (click its toolbar icon). Enter the port
   (`8788` unless `PL_WS_PORT` is set) and the token from
   `~/.projectionlab-mcp/ws-token`, which the server creates on first start.
   The status changes to **Connected** and the toolbar icon shows a green
   check.
4. Open https://app.projectionlab.com and log in.

A Firefox user whose setup worked before only needs step 2 again after
restarting Firefox: load `manifest.json` from the same folder, and re-enter
the port and token if the options page is empty. Do not repeat the rest of
the setup.

Quick, no install: call `projectionlab_get_bootstrap` and have the user paste
the returned snippet into the ProjectionLab tab's developer console (F12 ->
Console). It must be pasted again after every page reload.

## Reading the plan

- `projectionlab_get_summary` - Current Finances balances and current net
  worth. These are today's inputs, not projected outcomes.
- `projectionlab_describe_schema` - plan names and account IDs; use it to find
  identifiers before targeted reads.
- `projectionlab_get_plan`, `projectionlab_get_plan_section` - one plan, or one
  section of it (milestones, income, expenses, accounts, assets, priorities).
  `listPaths: true` lists editable field paths.
- `projectionlab_get_plan_settings` - assumptions (`variables`), Monte Carlo
  and withdrawal-strategy settings as dot paths with JSON types.
- `projectionlab_get_current_finances` - Current Finances, or the typed paths
  of one account.
- `projectionlab_export_data` - the full export. Large results are written to
  `~/.projectionlab-mcp/exports/` and returned as a file path.
- Resources: `projectionlab://knowledge` (data model, decumulation and tax
  concepts, analysis checklist). Prompts: `analyze-plan`, `compare-plans`,
  `optimize-tax`, `review-assumptions`.

Prefer the narrowest read that answers the question. The server reads plan
definitions; it does not run projections. Projected ending net worth and Chance
of Success are computed only in the ProjectionLab UI, so after a change ask the
user to recalculate there before drawing conclusions about its impact.

## Changing the plan

Change the plan only when the user explicitly asks for that change.

1. **Writes are off by default.** Every write tool fails with `READ_ONLY_MODE`
   until the user sets `PL_READ_ONLY=false` (MCP host `env` block or
   `~/.projectionlab-mcp/.env`) and restarts the server. Explain this and let
   the user decide; do not enable writes on your own.
2. **Preview first.** Every write tool is a dry run unless `confirm: true` is
   passed. Run the dry run, show the user the before/after values, and pass
   `confirm: true` only after the user approves that specific change.
3. **Prefer targeted patches.** `projectionlab_update_plan_settings`,
   `projectionlab_update_plan_event` and `projectionlab_update_account` change
   individual paths and keep siblings intact. Discover valid paths first with
   `listPaths: true`. Use `projectionlab_update_plan_section` and the
   `projectionlab_restore_*` tools only for deliberate wholesale replacement.
4. **Copy a plan to explore a what-if.** `projectionlab_clone_plan` adds a
   copy of a plan under a new name and leaves the original untouched; patch
   the copy with the targeted tools above.
5. **Handle `PLAN_CONFLICT`.** A plan write refuses with `PLAN_CONFLICT` when
   a plan was saved in ProjectionLab after the tool read it. Re-run the dry
   run to pick up the latest data and confirm again. When confirming
   `projectionlab_update_plan_section`, pass the dry run's `planVersion` as
   `expectedPlanVersion`.
6. **Every confirmed change is snapshotted first.** `projectionlab_list_snapshots`
   lists them and `projectionlab_rollback` restores one. Tell the user before
   the first change that it can be undone this way.
7. After a confirmed change, re-read the field to verify it.

## Privacy and advice

- Every figure in the plan is private financial data. Do not send, upload,
  publish or paste balances, positions, account identifiers or exports anywhere
  outside the conversation with the user.
- Never reveal `PL_API_KEY` or the WebSocket token.
- This server provides plan data and education, not personalized financial,
  investment or tax advice. Present analysis as information and point the user
  to a licensed professional for decisions. Verify current-year tax figures
  before relying on them; they change annually.
