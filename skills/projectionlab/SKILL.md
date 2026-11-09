---
name: projectionlab
description: Reads and edits a user's ProjectionLab retirement and financial plan through the projectionlab MCP server - plans, Current Finances, assumptions, Chance of Success (Monte Carlo) and withdrawal-strategy settings - with previewed, snapshotted, reversible changes. Use when the user asks about their ProjectionLab plan, retirement readiness, FIRE or decumulation, Roth conversions, comparing scenarios, or changing plan values, or when projectionlab tools fail to connect and the user needs setup help.
license: MIT
compatibility: Requires the projectionlab MCP server (npx -y projectionlab-mcp, Node.js 20+) and a ProjectionLab tab open in Chrome, Edge, Brave or Firefox 140+, connected through the MCP Bridge for ProjectionLab extension or the bootstrap snippet.
---

# ProjectionLab MCP

The `projectionlab` MCP server reads and edits a user's
[ProjectionLab](https://projectionlab.com) plan through the ProjectionLab Plugin
API. ProjectionLab has no REST API, so every call runs in the user's own
logged-in browser tab, relayed by a browser extension (or a pasted console
snippet) over a localhost WebSocket. If the browser side is not connected, no
tool can reach the plan.

Every tool name starts with `projectionlab_`. Hosts may add their own prefix
for the server (for example `mcp__projectionlab__` in Claude Code). The server
also serves this guide as the MCP resource `projectionlab://guide`.

## Start every session with a connection check

Call `projectionlab_check_connection` before any other ProjectionLab tool. It
returns `browser`, `pageLoaded`, `apiAvailable`, `apiKeyValid` and `errors`.
When every flag is `true`, proceed. Otherwise fix the first failing item with
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
Plugins. Each setting is read from the first of these that sets it:

1. The `env` block of this server in the MCP host's config.
2. `~/.projectionlab-mcp/.env`, shared by every MCP host on the machine, as the
   line `PL_API_KEY=...`. Keep the file readable only by the user
   (`chmod 600`).

The MCP host must restart the server after the key changes. Never invent a key,
and never print, echo, log or store the key in a conversation, file or commit.
If you write the file for the user, do not repeat the value back.

### Connecting the browser

Recommended, persistent: the **MCP Bridge for ProjectionLab** browser extension.

1. Download the zip for the user's browser (`chromium` or `firefox`) from
   https://github.com/Backroads4Me/projectionlab-mcp/releases/latest and unzip
   it.
2. Chrome, Edge or Brave: open `chrome://extensions`, enable **Developer mode**,
   choose **Load unpacked**, and select the unzipped folder. Firefox 140+: open
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

Plans are addressed by `planIdentifier`: a plan name (case-insensitive,
partial match) or an exact plan ID. Prefer the narrowest read that answers the
question.

| Question | Tool |
|---|---|
| Plan names, account IDs, counts | `projectionlab_describe_schema` |
| Today's balances and net worth | `projectionlab_get_summary` |
| One whole plan | `projectionlab_get_plan` |
| One section of a plan, one event, or one path in it | `projectionlab_get_plan_section` |
| Assumptions, Chance of Success, withdrawal strategy | `projectionlab_get_plan_settings` |
| Current Finances, or one account's editable paths | `projectionlab_get_current_finances` |
| Everything (rarely needed) | `projectionlab_export_data` |
| Snapshots already saved (id, time, operation, sections) | `projectionlab_list_snapshots` |
| What changed between a snapshot and now, or between two snapshots | `projectionlab_diff` |

- `projectionlab_describe_schema` lists accounts by type. A real-estate
  asset appears as `type: "real-estate"` with `marketValue` and `loanBalance`
  instead of `balance`: ProjectionLab stores a property's loan in `balance`
  and its market value in `amount`, so the two are never the same number.
- `projectionlab_get_plan_section` takes a `section` (`income`, `expenses`,
  `accounts`, `assets`, `milestones`, `priorities`, `variables`,
  `withdrawalStrategy`, `montecarlo`), and optionally an `eventIdentifier`
  (event name or ID), a `path` such as `events[2].rothConversions`, and
  `listPaths: true` to list editable dot paths with their JSON types.
- `projectionlab_get_plan_settings` returns `variables`, `montecarlo` and
  `withdrawalStrategy` as dot paths with JSON types; pass `section` for one.
- `projectionlab_get_current_finances` with an exact `accountId` and
  `listPaths: true` lists that account's editable paths. Real-estate assets
  (`type: "real-estate"` in `assets`) carry a `realEstate` block:
  `marketValue` (stored `amount`), `loanBalance` (the loan's `balance`, not
  the property's value; absent reads as 0), `netEquity` (marketValue minus
  loanBalance, not the app's net-worth figure), loan terms when
  `paymentMethod: "financed"`, and carrying costs where present. Answer
  questions about a property's value or equity from that block, not from
  the raw `balance`.
- `projectionlab_diff` answers "what changed?" in one read-only call, so it
  works with `PL_READ_ONLY=true`. `from` selects a saved snapshot with exactly
  one of `snapshotId`, `nBack` or `beforeTime`, the same selectors
  `projectionlab_rollback` takes and resolves the same way; `to` selects another
  snapshot, or omit it to compare against the data in ProjectionLab now. Only
  the sections the `from` snapshot holds are compared, and `comparedSections`
  names them. Each changed event comes back as
  `"path": "before → after"` dot paths, the form
  `projectionlab_get_plan_section` reads and `projectionlab_update_plan_event`
  patches, so a reported path is also the path to fix. `lastUpdated`, `simKey`
  and `meta` are left out, so a plan ProjectionLab merely re-saved reads as
  unchanged; a renamed event reads as one removed plus one added. Narrow with
  `planIdentifier` and `section`. Output is capped, with `omittedFieldChanges`
  counting what was left out. Use it to confirm a write landed as intended, to
  tell the user what changed, or to see what a rollback would undo.
- Results over about 100,000 characters are written to
  `~/.projectionlab-mcp/exports/` and returned as a file path. Read the parts
  you need from the file.
- `projectionlab_describe_plugin_api` lists the Plugin API methods the running
  app exposes. Use it before concluding that a capability does not exist.

Resources: `projectionlab://knowledge` (data model, FIRE and decumulation
concepts, retirement tax concepts without yearly figures, an analysis
checklist, and an index of ProjectionLab help articles),
`projectionlab://summary` and `projectionlab://plan-data` (full export).
Prompts: `analyze-plan` and `optimize-tax` (`planName`), `compare-plans`
(`plan1`, `plan2`), `review-assumptions` (`planName`).

Account vocabulary: `projectionlab://knowledge` defines the account types. Say
`taxable`, `tax-deferred` or `tax-free`; do not say "pre-tax" or "post-tax".

### What the server cannot tell you

The server reads plan inputs; it does not run projections. Projected ending
net worth and Chance of Success are computed only in the ProjectionLab UI.
`projectionlab_get_summary` reports today's balances, not outcomes, and a
write's before/after values confirm that an input changed, not what the change
did to the plan. To judge a change's impact, ask the user to recalculate the
plan and run Chance of Success in ProjectionLab, and compare those results.

### The data is a backup export, not the app's logic

The tools read the same data ProjectionLab saves for backups. It holds stored
values; it is not an API, and it does not contain the application logic.

- A field being present does not mean the app uses it. Some fields are left
  over from older versions; others matter only when another setting is on.
- Defaults, how settings interact, tax rules, and how milestones resolve live in
  the app, not in the data. Do not infer what a field does from its name or its
  value alone.
- When a write reports that a value was stored, that proves the value was
  stored. It does not prove the app reads it or acts on it.

When a change's effect matters, the user has to look at the result in the
ProjectionLab UI. The stored data cannot show it.

## Changing the plan

Change the plan only when the user explicitly asks for that change.

### Never do

- Never guess a path. Read it first with `projectionlab_get_plan_settings`,
  `projectionlab_get_plan_section` or `projectionlab_get_current_finances`,
  the last two with `listPaths: true`.
- Never skip the dry run, and never pass `confirm: true` until the user has
  said yes to the change that exact dry run showed.
- Never write to a plan the user did not name. If the user named no plan and
  more than one exists, ask which one before calling any write tool.
- Never invent an ID. Copy plan, account and event IDs exactly from
  `projectionlab_describe_schema` or the read tool you just called. Most write
  tools also accept a plan name; `projectionlab_delete_plan` takes an exact
  plan ID only.
- Never remove the Retirement or the Life Expectancy milestone. ProjectionLab
  always keeps both.
- Never state a yearly tax figure, bracket, threshold or deduction from
  memory; they change every year. Use `projectionlab://knowledge` for the
  concepts and have the user check current figures.
- Never call a write tool before `projectionlab_check_connection` returns
  every flag `true`.
- Never replace a whole section when a targeted tool can make the change.
  `projectionlab_update_plan_section` overwrites the complete array, so any
  event missing from what you send is gone.

**Writes are off by default.** Every write tool fails with `READ_ONLY_MODE`
until the user sets `PL_READ_ONLY=false` (MCP host `env` block or
`~/.projectionlab-mcp/.env`) and restarts the server. Explain this and let the
user decide; do not enable writes on your own.

### Choose the write tool

Every tool below also takes `confirm` (default `false`, a dry run).

| Change | Tool | Input |
|---|---|---|
| Assumption, Chance of Success or withdrawal setting | `projectionlab_update_plan_settings` | `planIdentifier`, `section`, `changes` (path -> value) |
| One income, expense, account, asset, milestone or priority event in a plan | `projectionlab_update_plan_event` | `planIdentifier`, `section`, `eventIdentifier`, `pathChanges` |
| One Current Finances account, debt or real asset | `projectionlab_update_account` | `accountId` (exact), `pathChanges` |
| A what-if copy of a plan | `projectionlab_clone_plan` | `planIdentifier`, `newName` |
| Remove a plan the user has decided to discard | `projectionlab_delete_plan` | `planId` (exact ID only) |
| A whole plan section, rebuilt deliberately | `projectionlab_update_plan_section` | `planIdentifier`, `section`, complete `sectionData`, plus `expectedPlanVersion` from the dry run |
| Replace a whole data area (rare) | `projectionlab_restore_plans`, `projectionlab_restore_current_finances`, `projectionlab_restore_progress`, `projectionlab_restore_settings` | `plans`, `currentFinances`, `progress`, `settings`: the complete replacement |
| Undo a confirmed change | `projectionlab_rollback` | exactly one of `snapshotId`, `nBack`, `beforeTime` |

Prefer the targeted tools: they change only the paths given and keep sibling
values intact. Paths must already exist and keep their JSON type; get them from
the matching read tool (`get_plan_settings`, `get_plan_section` with
`listPaths: true`, or `get_current_finances` with `listPaths: true`). The
older `patch` (events) and `data` (accounts) inputs merge top-level fields
only; supply exactly one of the patch inputs.

Milestones: ProjectionLab always keeps a Retirement and a Life Expectancy
milestone and disables deleting them in the app, so never remove either one.
`projectionlab_update_plan_section` replaces the whole `milestones` array, so
send both of them back in it.

To explore a what-if without touching the original, clone the plan first and
patch the copy.

`projectionlab_delete_plan` takes an exact plan ID only, never a name, and
refuses the last remaining plan. Its snapshot lets
`projectionlab_rollback` restore the deleted plan.

`projectionlab_restore_current_finances`, `projectionlab_restore_plans`,
`projectionlab_restore_progress` and `projectionlab_restore_settings` replace
an entire data area. Use them only when the user wants exactly that.

### Change workflow

Copy this checklist and work through it for each change:

```
Change progress:
- [ ] 1. Read the current value and its path
- [ ] 2. Dry run (no confirm) and show the user the before/after values
- [ ] 3. Get the user's approval for this specific change
- [ ] 4. Re-run the same call with confirm: true
- [ ] 5. Re-read the field to verify it landed
- [ ] 6. Ask the user to recalculate in ProjectionLab if impact matters
```

- **Every write tool is a dry run unless `confirm: true` is passed.** Pass it
  only after the user approves the change the dry run showed.
- **Every confirmed change is snapshotted first.** Tell the user before the
  first change that it can be undone: `projectionlab_list_snapshots` lists the
  snapshots and `projectionlab_rollback` restores one (also a dry run until
  confirmed). Choose the snapshot with exactly one of `snapshotId`, `nBack`
  (how many snapshots back, 1 being the most recent) or `beforeTime` (an ISO
  8601 time carrying an explicit `Z` or `±HH:MM` offset, such as
  `2026-11-08T15:30:00Z` or `2026-11-08T15:30:00+02:00`; the latest snapshot
  strictly before it. A time with no offset is refused rather than read as
  local time). `nBack` counts snapshots in the order
  `projectionlab_list_snapshots` shows them, including the pre-rollback
  snapshot a confirmed rollback saves, so a rollback is undone by rolling
  back once more with `nBack: 1`.
- **`PLAN_CONFLICT`** means a plan was saved in ProjectionLab after the tool
  read it, so the write was refused to avoid overwriting that edit. Re-run the
  dry run to pick up the latest data, show the user the new preview, and
  confirm again. When confirming `projectionlab_update_plan_section`, pass the
  dry run's `planVersion` as `expectedPlanVersion`.
- **`INVALID_INPUT`** usually means an unknown path or a changed JSON type.
  List the paths again and correct the call.

## Worked examples

The ids and names below are placeholders; use what the read tools returned.

**Change a setting.** User: "Raise my inflation assumption to 3% in my Retire
at 55 plan."

1. `projectionlab_get_plan_settings` with `planIdentifier: "Retire at 55"`,
   `section: "variables"` shows the path `inflation` with JSON type `number`
   and its current value, a fraction such as `0.025`.
2. `projectionlab_update_plan_settings` with
   `{"planIdentifier": "Retire at 55", "section": "variables", "changes": {"inflation": 0.03}}`
   returns the dry-run diff. Show it to the user.
3. After the user approves, repeat the call with `"confirm": true`, then
   re-read the setting and suggest recalculating the plan in ProjectionLab.

**Clone a plan.** User: "Copy my Retire at 55 plan so I can try retiring
at 60."

1. `projectionlab_describe_schema` gives the source plan's exact id and shows
   the new name is not already taken.
2. `projectionlab_clone_plan` with
   `{"planIdentifier": "plan_abc123", "newName": "Retire at 60 what-if"}`
   returns `dryRun: true`, the source plan, `planCount` such as `2 → 3`, and
   the per-section event counts. Its plan id is provisional: the new id is
   assigned again on confirm. Show the preview to the user.
3. After the user approves, repeat with `"confirm": true`. The reply gives
   `verified` and a `snapshotId`; `projectionlab_rollback` to that snapshot
   removes the copy. Then edit the copy with the targeted write tools.

**Delete a plan.** User: "Delete the Test Scenario plan."

1. `projectionlab_describe_schema` gives the plan's exact id, such as
   `plan_abc123`. Deletion accepts only that id, never a name, and refuses the
   last remaining plan.
2. `projectionlab_delete_plan` with `{"planId": "plan_abc123"}` returns
   `dryRun: true`, the plan name and id, `planCount` such as `2 → 1`, and the
   event counts that go with the plan. Show the preview; wait for the go-ahead.
3. Repeat with `{"planId": "plan_abc123", "confirm": true}`. The reply gives
   `verified` and a `snapshotId`; `projectionlab_rollback` to that snapshot
   restores the deleted plan.

**Undo the last change.** User: "Undo that."

1. `projectionlab_list_snapshots` lists snapshots newest first with `id`,
   `timestamp`, `operation` and `sections`.
2. `projectionlab_rollback` with `{"nBack": 1}` resolves the selector and
   returns `dryRun: true`, the `snapshotId` it picked, its `timestamp`,
   `operation`, and the `sections` it would restore. Show the preview.
3. `projectionlab_diff` with `{"from": {"nBack": 1}}` takes the same selector
   and picks the same snapshot, so its field-level list of what differs from the
   live data shows exactly what that rollback would undo. Show it with the
   preview when the user asks what will come back.
4. After the user approves, repeat with `{"nBack": 1, "confirm": true}`. A
   confirmed rollback saves the current state first, so another `nBack: 1`
   right after a rollback undoes that rollback.
5. `snapshotId` names one id from the list. `beforeTime` takes an ISO 8601
   time carrying a `Z` or `±HH:MM` offset, such as `2026-11-08T15:30:00Z`,
   and restores the latest snapshot strictly before it; a time with no
   offset is refused.

## Privacy and advice

- Every figure in the plan is private financial data. Do not send, upload,
  publish or paste balances, positions, account identifiers or exports anywhere
  outside the conversation with the user.
- Never reveal `PL_API_KEY` or the WebSocket token.
- This server provides plan data and education, not personalized financial,
  investment or tax advice. Present analysis as information and point the user
  to a licensed professional for decisions. Verify current-year tax figures
  before relying on them; they change annually.
