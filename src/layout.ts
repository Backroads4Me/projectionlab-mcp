import { ProjectionLabError } from "./errors.js";
import type { WireMethod } from "./types/wire.js";

/**
 * The ProjectionLab Plugin API contract and export layout this server reads.
 *
 * The Plugin API reports its contract major version as `api.version`: 2 on
 * ProjectionLab 5 (ProjectionLab Plugin API reference, PluginAPI.version).
 * The server supports contract 2 only. A page whose API has no `version` is
 * ProjectionLab 4, which ProjectionLab has retired, and is refused.
 *
 * Contract 2 exports `{ schema, exportedAt, documents: { currentFinances,
 * plans, settings, accountHistory, progress? } }`, each document carrying its
 * own `schema`.
 */
export type ApiContract = 2;
/** The export layout snapshots record (`Snapshot.layout`). */
export type ExportLayout = "v5";

/**
 * Write methods ProjectionLab 5's Plugin API offers, each verified against
 * it. The write tools and the bridge refuse any other write method.
 *
 * restoreProgress is absent: ProjectionLab 5's restoreProgress always
 * throws, because the app records Progress history itself whenever a
 * current value changes.
 */
export const CONTRACT_2_WRITES: ReadonlySet<WireMethod> = new Set<WireMethod>([
  // ProjectionLab 5's restorePlans(plans, { key }) replaces the whole plans
  // list: a plan missing from the array is deleted.
  "restorePlans",
  // updateAccount(accountId, data, { key, force }) assigns `data` over the
  // top-level fields of `currentFinances.accounts[accountId]`. It refuses a
  // change of `id` or `kind`, an unsupported `type`/`subtype`, and, without
  // `force`, a field the account lacks.
  "updateAccount",
  // restoreCurrentFinances(currentFinances, { key }) takes every non-account
  // field from the submission, replaces each submitted account whole, and
  // keeps any stored account the submission leaves out: it never deletes an
  // account. Rolling back an account change through it is exact.
  "restoreCurrentFinances",
  // restoreSettings(settings, { key }) replaces the whole settings document,
  // after ProjectionLab's own validation of the document, and marks it
  // unsaved so the app saves it.
  "restoreSettings",
]);

/** Whether ProjectionLab 5 offers the write method `method`. */
export function writeSupported(method: WireMethod): boolean {
  return CONTRACT_2_WRITES.has(method);
}

/** The refusal for a write method ProjectionLab 5 does not offer. */
export function writeNotSupportedError(method: WireMethod): ProjectionLabError {
  return new ProjectionLabError(
    "WRITE_NOT_SUPPORTED",
    `${method} is not available on ProjectionLab 5`,
    "Make the change in the ProjectionLab app. Nothing was written.",
  );
}

/** The refusal for a ProjectionLab 4 page, whose Plugin API has no version. */
export function projectionLab4Error(): ProjectionLabError {
  return new ProjectionLabError(
    "UNSUPPORTED_API_VERSION",
    "The ProjectionLab page offers the ProjectionLab 4 Plugin API, which this server no longer supports",
    "Reload the ProjectionLab tab so it runs ProjectionLab 5. Nothing was read or written.",
  );
}

/** The contract named by a Plugin API `version` value; only 2 is accepted. */
export function contractFromVersion(version: unknown): ApiContract {
  if (version === 2) return 2;
  if (version === undefined || version === null) throw projectionLab4Error();
  throw new ProjectionLabError(
    "UNSUPPORTED_API_VERSION",
    `The ProjectionLab Plugin API reports contract version ${JSON.stringify(version)}, which this server does not support`,
    "Update projectionlab-mcp to a release that supports this ProjectionLab version. Nothing was read or written.",
  );
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Whether a raw `exportData` result has the ProjectionLab 5 shape. */
export function isV5Export(raw: unknown): boolean {
  return isObj(raw) && typeof raw.schema === "number" && isObj(raw.documents);
}

/** An export's sections under one set of names. */
export interface ExportSections {
  /** Every plan document. */
  plans: unknown[];
  currentFinances: unknown;
  settings: unknown;
  /** Absent unless the export carries older history; ProjectionLab 5 keeps
   * per-account history in `accountHistory`. */
  progress: unknown;
  accountHistory: unknown;
}

/**
 * Reads an export's sections. An export without the ProjectionLab 5 shape is
 * refused, and so is one without a plans array rather than read as "no
 * plans", since every profile has a Main Plan and an empty list would pass
 * plan conflict checks against a real one.
 */
export function exportSections(raw: unknown): ExportSections {
  if (!isV5Export(raw)) {
    throw new ProjectionLabError(
      "UNSUPPORTED_API_VERSION",
      "The ProjectionLab export is not in the ProjectionLab 5 format this server reads",
      "Reload the ProjectionLab tab so it runs ProjectionLab 5, then try again. Nothing was written.",
    );
  }
  const docs = (raw as Obj).documents as Obj;
  if (!Array.isArray(docs.plans)) {
    throw new ProjectionLabError(
      "UNKNOWN",
      "The ProjectionLab export has no plans list in documents.plans",
      "Reload the ProjectionLab tab and try again. If it persists, ProjectionLab's export format may have changed.",
    );
  }
  return {
    plans: docs.plans,
    currentFinances: docs.currentFinances,
    settings: docs.settings,
    progress: docs.progress,
    accountHistory: docs.accountHistory,
  };
}

/** One named section of an export. */
export function sectionOf(raw: unknown, section: string): unknown {
  const sections = exportSections(raw);
  switch (section) {
    case "currentFinances":
      return sections.currentFinances;
    case "plans":
      return sections.plans;
    case "progress":
      return sections.progress;
    case "settings":
      return sections.settings;
    default:
      return undefined;
  }
}

/**
 * Refuses a snapshot that was not taken from ProjectionLab 5. A snapshot
 * without a recorded layout predates layout tracking and holds ProjectionLab
 * 4 data, which ProjectionLab 5's Plugin API cannot take: a ProjectionLab 4
 * backup is restored only through the app's own Restore action
 * (ProjectionLab Plugin API reference, restore methods).
 */
export function assertSnapshotLayout(
  snapshotLayout: unknown,
  fix = "ProjectionLab 5 cannot take ProjectionLab 4 data through the Plugin API. Restore a ProjectionLab 4 backup with the Restore action in the ProjectionLab app instead. Nothing was written.",
): void {
  if (snapshotLayout === "v5") return;
  throw new ProjectionLabError(
    "LAYOUT_MISMATCH",
    "This snapshot was taken from ProjectionLab 4, which this server no longer supports",
    fix,
  );
}
