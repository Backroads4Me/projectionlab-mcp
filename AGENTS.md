# AGENTS.md

Guidance for AI agents and contributors working in this repository.

Workspace rules: `../AGENTS.md`.

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
npm test                          # node --test (fake-executor + bootstrap suites)
```

The browser side connects via the extension (see `extension/README.md`) or the
`projectionlab_get_bootstrap` snippet. Validate changes with `npm run build`
(zero errors), `npm test`, and, when a browser is connected,
`projectionlab_check_connection`.

## Layout

- `src/index.ts`: server bootstrap; registers all tools, resources, prompts.
- `src/bridge.ts`: the `Bridge` interface all consumers type against.
- `src/extensionBridge.ts`: WebSocket relay to the browser executor.
- `src/bootstrap.ts`: generates the Tier-0 console snippet.
- `src/types/wire.ts`: the wire protocol contract (server ⇄ executor).
- `extension/`: the Manifest V3 browser extension.
- `src/config.ts`: env parsing; the single source of config (`config.*`).
  Precedence: host env, then `~/.projectionlab-mcp/.env`, then the package-root `.env`.
- `src/instructions.ts`: server instructions sent at initialize, and the
  loader for the agent guide.
- `skills/projectionlab/SKILL.md`: the agent guide for *users* of the server,
  shipped in the package and served as `projectionlab://guide`. Keep it in
  step with tool names and behavior. This file (`AGENTS.md`) is for
  contributors.
- `src/redact.ts`: secret scrubbing for anything persisted or exported.
- `src/snapshot.ts`: pre-write snapshots + retention.
- `src/tools/*`: one file per tool; each exports a `register…Tool(server, …)`.
- `src/resources/*`: MCP resources (`plan-data`, `summary`, `knowledge`).
- `src/prompts/index.ts`: analysis prompt templates.

## Conventions

- **ESM + NodeNext**: local imports use the `.js` extension even from `.ts`.
- **Tools**: register with `server.registerTool`, validate inputs with `zod`,
  serialize output with `toJson` (respects `PL_PRETTY_JSON`), and return errors
  via `errorResult(err)` / throw `ProjectionLabError`.
- **Annotations**: set `readOnlyHint`/`destructiveHint` honestly on every tool.
- **No new deps** without good reason; keep the runtime footprint small.

## Safety model (do not weaken)

- Writes (`update_*`, `restore_*`) are **dry-run by default**; execute only with
  `confirm: true`.
- Every confirmed mutation **auto-snapshots** the affected section first
  (`SnapshotManager.create`) so `projectionlab_rollback` can undo it.
- Writes are disabled unless `PL_READ_ONLY=false`; `checkReadOnly()` enforces it.
- **Never** print, log, or persist `PL_API_KEY`. Anything written to disk
  (snapshots) or emitted as a full export goes through `redactSecrets` first:
  snapshots value-only (restore-safe), exports/resources aggressive (`byName`).

## After changing code

The host keeps compiled `dist/` in memory. Rebuild and restart the MCP host:

```bash
npm run build   # then restart Claude Code / your MCP host
```

## Releasing

Publishing is gated to CI on a GitHub Release: `.github/workflows/publish.yml`
publishes to npm with provenance, and `.github/workflows/extension-release.yml`
attaches the extension zips to the release. Do not publish, tag, or bump the version as part of routine
work. That's an explicit, human-initiated step.
