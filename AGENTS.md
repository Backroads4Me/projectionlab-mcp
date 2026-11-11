# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## What this is

A local **stdio MCP server** (TypeScript, ESM) that bridges an MCP host to the
ProjectionLab **Plugin API** (`window.projectionlabPluginAPI`). ProjectionLab has
no REST API, so the server opens a localhost WebSocket that a browser-side
executor (the extension in `extension/`, or a pasted bootstrap snippet) connects
to and drives the browser-side API in the user's logged-in tab. See
`HOW-IT-WORKS.md` for the architecture.

## Setup, build, run

```bash
npm install
cp .env.example .env              # set PL_API_KEY
npm run build                     # tsc -> dist/
npm run dev                       # run from source (tsx) for local iteration
npm test                          # build, then node --test over test/*.test.mjs
```

The extension has its own package; check it from `extension/`:

```bash
cd extension
npm ci
npm run check                     # syntax checks + node --test over test/*.test.mjs
npm run build                     # esbuild -> dist/chromium, dist/firefox
```

The browser side connects via the extension (see `extension/README.md`) or the
`projectionlab_get_bootstrap` snippet. Validate changes with `npm run build`
(zero errors), `npm test`, the extension checks above when `extension/`
changed, and, when a browser is connected, `projectionlab_check_connection`.
CI (`.github/workflows/ci.yml`) runs both the server and the extension
checks on Node 20 for every pull request and push to `main`.

## Layout

- `src/index.ts`: server bootstrap; registers all tools, resources, prompts.
- `src/version.ts`: the release version, read from the root `package.json`.
- `src/config.ts`: env parsing; the single source of config (`config.*`).
  Precedence: host env, then `~/.projectionlab-mcp/.env`, then the package-root `.env`.
- `src/bridge.ts`: the `Bridge` interface all consumers type against.
- `src/extensionBridge.ts`: WebSocket relay to the browser executor.
- `src/bootstrap.ts`: generates the Tier-0 console snippet.
- `src/types/wire.ts`: the wire protocol contract (server ⇄ executor).
- `src/instructions.ts`: server instructions sent at initialize, and the
  loader for the agent guide.
- `src/plans.ts`: plan, section, and event lookup helpers shared by the tools.
- `src/versionCompare.ts`: numeric `major.minor.patch` comparison; `null` for
  anything unparsable, which callers treat as "say nothing".
- `src/updateCheck.ts`: the one npm-registry lookup per server process
  (`PL_UPDATE_CHECK`), with the remembered latest version.
- `src/versionNotices.ts`: the plain-language update notices carried by
  `projectionlab_check_connection`.
- `src/summary.ts`: the Current Finances summary shared by `get_summary` and
  `projectionlab://summary`.
- `src/planVersion.ts`: plan version tokens and the `PLAN_CONFLICT` checks.
- `src/pathPatch.ts`: path-addressed value listing and patching for updates.
- `src/redact.ts`: secret scrubbing for anything persisted or exported.
- `src/logger.ts`: structured stderr logger, scrubbing `PL_API_KEY` from all output.
- `src/largeOutput.ts`: writes oversized tool outputs to `~/.projectionlab-mcp/exports/` with 30-day retention.
- `src/dataModel.ts`: ProjectionLab data model annotations and validation.
- `src/snapshot.ts`: pre-write snapshots + retention.
- `src/secureFs.ts`: owner-only directory and file writes.
- `src/tools/*`: one file per tool or closely related group (`restore.ts`,
  `snapshots.ts`); each exports a `register…Tool(s)(server, …)`.
- `src/resources/*`: MCP resources (`data-model`, `guide`, `knowledge`, `plan-data`, `summary`).
- `src/prompts/index.ts`: analysis prompt templates.
- `skills/projectionlab/SKILL.md`: the agent guide for *users* of the server,
  shipped in the package and served as `projectionlab://guide`. Keep it in
  step with tool names and behavior. This file (`AGENTS.md`) is for
  contributors.
- `extension/`: the Manifest V3 browser extension (its own package).
- `test/`: server test suites (`node --test`, with a fake executor).
- `.github/workflows/`: CI, npm publish, and extension release.

## Conventions
- **ESM + NodeNext**: local imports use the `.js` extension even from `.ts`.
- **Tools**: register with `server.registerTool`, validate inputs with `zod`,
  serialize output with `toJson` (respects `PL_PRETTY_JSON`), and return errors
  via `errorResult(err)` / throw `ProjectionLabError`.
- **Annotations**: set `readOnlyHint`/`destructiveHint` honestly on every tool.
- **Logging**: all server logging uses `log.*` from `src/logger.ts`, which scrubs
  `PL_API_KEY` from every line and writes to stderr (stdout is strictly for stdio
  MCP JSON-RPC). Direct `console.*` calls are forbidden outside `logger.ts` and
  `bootstrap.ts` (enforced by `test/no-console.test.mjs`).
- **No new deps** without good reason; keep the runtime footprint small.

## Safety model (do not weaken)

- Writes (`update_*`, `restore_*`, `clone_plan`) are **dry-run by default**;
  execute only with `confirm: true`.
- Every confirmed mutation **auto-snapshots** the affected section first
  (`SnapshotManager.create`) so `projectionlab_rollback` can undo it.
- Plan writes replace the whole plans array, so each confirmed plan write
  re-reads the plans and refuses with `PLAN_CONFLICT` if any changed since the
  tool read them (`assertPlansUnchanged`, plus `expectedPlanVersion` on
  `update_plan_section`). A plan saved in ProjectionLab meanwhile is never
  overwritten.
- Writes refuse payloads carrying the redaction sentinel (`[REDACTED]`) under
  sensitive field names, preventing accidental overwrite with redacted reads.
- `update_plan_section` validates the shape of `sectionData` against the
  section's expected schema before applying changes.
- Writes are disabled unless `PL_READ_ONLY=false`; every mutating tool checks
  `config.readOnly` before writing.
- Only one browser executor connects at a time; competing connections are
  answered with `BUSY` and stand by without disrupting the active session.
- **Never** print, log, or persist `PL_API_KEY`. Anything written to disk
  (snapshots) or returned as plan data goes through the redaction helpers in
  `src/redact.ts` first: snapshots store the literal key as the restorable
  `SNAPSHOT_KEY_PLACEHOLDER` (put back on every read, so rollback stays
  exact); exports, plan reads (`get_plan`, `get_plan_section`, and similar),
  and resources are scrubbed by name (`byName: true`) as well as by value.

## After changing code

The host keeps compiled `dist/` in memory. Rebuild and restart the MCP host:

```bash
npm run build   # then restart Claude Code / your MCP host
```

## Releasing

The server release version is in root `package.json`. The extension release
version is in `extension/package.json`. The server enforces a minimum required
extension version (`MIN_EXTENSION_VERSION` in `src/types/wire.ts`) rather than
requiring lockstep version parity, allowing the server to release independently
without forcing extension updates. Compatibility on the wire is governed by
`PROTOCOL_VERSION` (`src/types/wire.ts`).

Publishing is gated to CI on a GitHub Release: `.github/workflows/publish.yml`
publishes to npm with provenance, and `.github/workflows/extension-release.yml`
attaches the extension zips to the release. Both fail unless the release tag is
`v` followed by the `package.json` version. Do not publish, tag, or bump the
version as part of routine work. That's an explicit, human-initiated step.
