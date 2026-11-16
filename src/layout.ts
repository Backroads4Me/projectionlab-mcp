import { ProjectionLabError } from "./errors.js";
import type { WireMethod } from "./types/wire.js";

/**
 * ProjectionLab Plugin API contracts and export layouts.
 *
 * The Plugin API reports its contract major version as `api.version`: 2 on
 * ProjectionLab 5, absent on ProjectionLab 4, so `api.version ?? 1` names the
 * contract (ProjectionLab Plugin API reference, PluginAPI.version). The
 * contract is independent of the app version and of the export schema.
 *
 * The two contracts export different layouts:
 * - "v4" (contract 1): `{ meta, today, plans, settings, progress }`.
 * - "v5" (contract 2): `{ schema, exportedAt, documents: { currentFinances,
 *   plans, settings, accountHistory, progress? } }`, each document carrying
 *   its own `schema`.
 */
export type ApiContract = 1 | 2;
export type ExportLayout = "v4" | "v5";

/**
 * Write methods allowed on contract 2, each verified against ProjectionLab
 * 5's Plugin API. The write tools and the bridge refuse any other write
 * method on contract 2. Contract 1 allows every write method.
 *
 * restoreProgress is absent: ProjectionLab 5's restoreProgress always
 * throws, because the app records Progress history itself whenever a
 * current value changes.
 */
export const CONTRACT_2_WRITES: ReadonlySet<WireMethod> = new Set<WireMethod>([
  // ProjectionLab 5's restorePlans(plans, { key }) replaces the whole plans
  // list, as on ProjectionLab 4: a plan missing from the array is deleted.
  "restorePlans",
  // updateAccount(accountId, data, { key, force }) assigns `data` over the
  // top-level fields of `currentFinances.accounts[accountId]`, as on
  // ProjectionLab 4. It refuses a change of `id` or `kind`, an unsupported
  // `type`/`subtype`, and, without `force`, a field the account lacks.
  "updateAccount",
  // restoreCurrentFinances(currentFinances, { key }) takes every non-account
  // field from the submission, replaces each submitted account whole, and
  // keeps any stored account the submission leaves out: it never deletes an
  // account. Rolling back an account change through it is exact.
  "restoreCurrentFinances",
  // restoreSettings(settings, { key }) replaces the whole settings document,
  // as on ProjectionLab 4, after ProjectionLab's own validation of the
  // document, and marks it unsaved so the app saves it.
  "restoreSettings",
]);

/** Whether `method` may write to a page offering `contract`. */
export function writeSupported(contract: ApiContract, method: WireMethod): boolean {
  return contract !== 2 || CONTRACT_2_WRITES.has(method);
}

/** The refusal for a write method the page's contract does not offer. */
export function writeNotSupportedError(method: WireMethod): ProjectionLabError {
  if (method === "restoreProgress") {
    return new ProjectionLabError(
      "WRITE_NOT_SUPPORTED",
      "ProjectionLab 5 removed restoreProgress",
      "ProjectionLab 5 records Progress history by itself whenever a current value changes, so Progress cannot be replaced. To bring back Progress from a backup file, use Restore in the ProjectionLab app. Nothing was written.",
    );
  }
  return new ProjectionLabError(
    "WRITE_NOT_SUPPORTED",
    `${method} is not available on ProjectionLab 5`,
    "Make the change in the ProjectionLab app. Nothing was written.",
  );
}

/** The contract named by a Plugin API `version` value. */
export function contractFromVersion(version: unknown): ApiContract {
  if (version === undefined || version === null) return 1;
  if (version === 2) return 2;
  throw new ProjectionLabError(
    "UNSUPPORTED_API_VERSION",
    `The ProjectionLab Plugin API reports contract version ${JSON.stringify(version)}, which this server does not support`,
    "Update projectionlab-mcp to a release that supports this ProjectionLab version. Nothing was read or written.",
  );
}

export function layoutForContract(contract: ApiContract): ExportLayout {
  return contract === 2 ? "v5" : "v4";
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The layout of a raw `exportData` result, from its shape. */
export function detectLayout(raw: unknown): ExportLayout {
  return isObj(raw) && typeof raw.schema === "number" && isObj(raw.documents) ? "v5" : "v4";
}

/** An export's sections under one set of names, whichever layout it has. */
export interface ExportSections {
  layout: ExportLayout;
  /** Every plan document. */
  plans: unknown[];
  /** v4 `today`, v5 `documents.currentFinances`. */
  currentFinances: unknown;
  settings: unknown;
  /** v4 `progress` (category totals). Absent from v5 unless the export
   * carries older history; v5 keeps per-account history in `accountHistory`. */
  progress: unknown;
  /** v5 `documents.accountHistory`; undefined on v4. */
  accountHistory: unknown;
}

/**
 * Reads an export's sections. A v5 export without a plans array is refused
 * rather than read as "no plans", since every v5 profile has a Main Plan and
 * an empty list would pass plan conflict checks against a real one.
 */
export function exportSections(raw: unknown): ExportSections {
  const layout = detectLayout(raw);
  if (layout === "v5") {
    const docs = (raw as Obj).documents as Obj;
    if (!Array.isArray(docs.plans)) {
      throw new ProjectionLabError(
        "UNKNOWN",
        "The ProjectionLab export has no plans list in documents.plans",
        "Reload the ProjectionLab tab and try again. If it persists, ProjectionLab's export format may have changed.",
      );
    }
    return {
      layout,
      plans: docs.plans,
      currentFinances: docs.currentFinances,
      settings: docs.settings,
      progress: docs.progress,
      accountHistory: docs.accountHistory,
    };
  }
  const data = isObj(raw) ? raw : {};
  return {
    layout,
    plans: Array.isArray(data.plans) ? data.plans : [],
    currentFinances: data.today,
    settings: data.settings,
    progress: data.progress,
    accountHistory: undefined,
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
 * Refuses a rollback of a snapshot taken from one export layout onto an
 * account that now exports the other. A snapshot without a recorded layout
 * predates layout tracking and is "v4". ProjectionLab 5 has no API path for
 * v4 data: v4 backups are restored only through the app's own Restore action
 * (ProjectionLab Plugin API reference, restore methods).
 */
export function assertSnapshotLayout(snapshotLayout: ExportLayout | undefined, live: ExportLayout): void {
  const taken = snapshotLayout ?? "v4";
  if (taken === live) return;
  throw new ProjectionLabError(
    "LAYOUT_MISMATCH",
    `This snapshot was taken from ${layoutLabel(taken)}, but the account now uses ${layoutLabel(live)}`,
    live === "v5"
      ? "ProjectionLab 5 cannot take ProjectionLab 4 data through the Plugin API. Restore a ProjectionLab 4 backup with the Restore action in the ProjectionLab app instead. Nothing was written."
      : "Data from ProjectionLab 5 cannot be written to a ProjectionLab 4 account. Nothing was written.",
  );
}

export function layoutLabel(layout: ExportLayout): string {
  return layout === "v5" ? "ProjectionLab 5" : "ProjectionLab 4";
}
