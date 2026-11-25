import { matchDataModelField } from "./dataModel.js";
import { startLabel } from "./plans.js";
import { REDACTED } from "./redact.js";
import { choiceText, formatValue, words } from "./settingsReport.js";

/**
 * Plain-language summaries of write-tool changes, carried as `summary` in each
 * write tool's dry-run and confirmed output. A summary names the plan, item,
 * and setting, and shows old and new values the way ProjectionLab displays
 * them, so an agent can relay it to the user as is.
 *
 * Every builder takes values already passed through `redactSecrets`, so a
 * summary never carries more than the JSON beside it. Each builder depends
 * only on the computed change, not on whether the write is confirmed.
 */

/** The most lines a summary lists before "and N more changes". */
export const SUMMARY_MAX_LINES = 20;

/** The marker `applyExistingPathChanges` stores for a field that is absent. */
const ABSENT = "[ABSENT]";

export interface SummaryFieldChange {
  before: unknown;
  after: unknown;
}

/** A section or collection name in words: "withdrawalStrategy" as
 * "Withdrawal strategy", "currentFinances" as "Current Finances". */
export function sectionTitle(section: string): string {
  if (section === "currentFinances") return "Current Finances";
  if (section === "montecarlo") return "Monte Carlo";
  return words(section);
}

/** A field path in words, for a field with no recorded on-screen label:
 * "allocation.stocks" as "Allocation stocks", "points.0.rate" as
 * "Points #1 rate". */
export function pathWords(path: string): string {
  const text = path
    .split(".")
    .map((segment) =>
      /^\d+$/.test(segment) ? `#${Number(segment) + 1}` : words(segment).toLowerCase(),
    )
    .join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function quoted(name: unknown): string {
  return `"${typeof name === "string" && name.length > 0 ? name : "unnamed"}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One stored value as ProjectionLab shows it, in the units the data model
 * records for its field; a value with no recorded units is shown plain. */
function valueText(
  value: unknown,
  path: string,
  units: string | undefined,
  allowedValues: readonly string[] | undefined,
): string {
  if (value === ABSENT || value === undefined) return "not set";
  if (value === REDACTED) return "(hidden)";
  if (
    Array.isArray(value) &&
    value.some((item) => isPlainObject(item) && Object.keys(item).length > 2)
  ) {
    return `${value.length} entr${value.length === 1 ? "y" : "ies"}`;
  }
  const leaf = path.split(".").pop() ?? path;
  return (
    choiceText(path, value, allowedValues) ??
    choiceText(leaf, value, allowedValues) ??
    formatValue(value, units)
  );
}

/** "Label: old → new" lines for path-addressed changes in one data-model
 * scope (a settings section, an event section, or "accounts"). */
export function fieldChangeLines(
  scope: string | undefined,
  changes: Record<string, SummaryFieldChange>,
): string[] {
  return Object.entries(changes).map(([path, { before, after }]) => {
    const field = scope ? matchDataModelField(scope, path) : undefined;
    const label = field?.uiLabel ?? pathWords(path);
    // A group of values is named, not listed: its contents may hold fields
    // the summary has no words for.
    if (isPlainObject(before) || isPlainObject(after)) return `${label}: changed`;
    const from = valueText(before, path, field?.units, field?.allowedValues);
    const to = valueText(after, path, field?.units, field?.allowedValues);
    return `${label}: ${from} → ${to}`;
  });
}

/** Lines past the cap folded into "and N more changes". */
export function capLines(
  lines: readonly string[],
  max: number = SUMMARY_MAX_LINES,
): string[] {
  if (lines.length <= max) return [...lines];
  const shown = lines.slice(0, max);
  const rest = lines.length - max;
  shown.push(`and ${rest} more change${rest === 1 ? "" : "s"}`);
  return shown;
}

function render(head: string, lines: readonly string[], tail?: string): string {
  const body = capLines(lines).map((line) => `- ${line}`);
  return [head, ...body, ...(tail ? [tail] : [])].join("\n");
}

const NO_CHANGE = "Nothing changes: every supplied value already matches.";
const BACKUP = "A backup is taken first, so this can be undone.";

/** A Current Finances record's kind as ProjectionLab names it. */
const KIND_WORDS: Record<string, string> = {
  account: "account",
  debt: "debt",
  "real-asset": "real asset",
};

export function accountChangeSummary(input: {
  accountName: unknown;
  kind?: string;
  changes: Record<string, SummaryFieldChange>;
}): string {
  const what = `Current Finances ${KIND_WORDS[input.kind ?? ""] ?? "account"} ${quoted(input.accountName)}`;
  if (Object.keys(input.changes).length === 0) return `${what}: ${NO_CHANGE}`;
  return render(`${what}:`, fieldChangeLines("accounts", input.changes), BACKUP);
}

/** The event fields that hold when an event starts and ends, with their
 * words. */
const TIMING_FIELDS: readonly [string, string][] = [
  ["start", "Starts"],
  ["end", "Ends"],
];

/** A start or end as the plan shows it: "not set" when absent, a keyword in
 * words, undefined for a kind the summary has no words for. */
function timingText(
  value: unknown,
  milestones: ReadonlyMap<string, string>,
): string | undefined {
  if (value === undefined || value === null || value === ABSENT) return "not set";
  const label = startLabel(value, milestones);
  if (label === undefined) return undefined;
  return isPlainObject(value) && value.type === "keyword" ? words(label).toLowerCase() : label;
}

export function planEventChangeSummary(input: {
  planName: unknown;
  section: string;
  eventName: string;
  changes: Record<string, SummaryFieldChange>;
  /** The event before and after the change, and the plan's milestone names,
   * so a start or end reads as the plan shows it ("Retirement", "age 65"). */
  timing?: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    milestones: ReadonlyMap<string, string>;
  };
}): string {
  const what = `Plan ${quoted(input.planName)}, ${sectionTitle(input.section).toLowerCase()} item ${quoted(input.eventName)}`;
  if (Object.keys(input.changes).length === 0) return `${what}: ${NO_CHANGE}`;
  const rest: Record<string, SummaryFieldChange> = { ...input.changes };
  const lines: string[] = [];
  const timing = input.timing;
  if (timing) {
    for (const [field, label] of TIMING_FIELDS) {
      const paths = Object.keys(rest).filter(
        (path) => path === field || path.startsWith(`${field}.`),
      );
      if (paths.length === 0) continue;
      const from = timingText(timing.before[field], timing.milestones);
      const to = timingText(timing.after[field], timing.milestones);
      // A start or end of a kind with no words stays as its field changes.
      if (from === undefined || to === undefined) continue;
      for (const path of paths) delete rest[path];
      lines.push(`${label}: ${from} → ${to}`);
    }
  }
  lines.push(...fieldChangeLines(input.section, rest));
  return render(`${what}:`, lines, BACKUP);
}

export function planSettingsChangeSummary(input: {
  planName: unknown;
  section: string;
  changes: Record<string, SummaryFieldChange>;
}): string {
  const what = `Plan ${quoted(input.planName)} settings, ${sectionTitle(input.section)}`;
  if (Object.keys(input.changes).length === 0) return `${what}: ${NO_CHANGE}`;
  return render(
    `${what}:`,
    fieldChangeLines(input.section, input.changes),
    BACKUP,
  );
}

/** A section replacement, item by item: field names only, since the values
 * of a whole-section write are listed in the diff beside it. */
export function planSectionChangeSummary(input: {
  planName: unknown;
  section: string;
  currentCount: number;
  newCount: number;
  added?: readonly string[];
  removed?: readonly string[];
  modified?: readonly { name: string; changes: Record<string, unknown> }[];
  fieldChanges?: Record<string, unknown>;
}): string {
  const lines: string[] = [];
  for (const name of input.added ?? []) lines.push(`Add ${quoted(name)}`);
  for (const name of input.removed ?? []) lines.push(`Remove ${quoted(name)}`);
  for (const { name, changes } of input.modified ?? []) {
    lines.push(`Change ${quoted(name)}: ${fieldNames(input.section, changes)}`);
  }
  const fields = Object.keys(input.fieldChanges ?? {});
  if (fields.length > 0) {
    lines.push(`Change ${fieldNames(input.section, input.fieldChanges ?? {})}`);
  }
  const what = `Plan ${quoted(input.planName)}, ${sectionTitle(input.section).toLowerCase()} section`;
  if (lines.length === 0) return `${what}: Nothing changes.`;
  const counts =
    input.currentCount === input.newCount
      ? `${input.newCount} item${input.newCount === 1 ? "" : "s"}`
      : `${input.currentCount} → ${input.newCount} items`;
  return render(`${what} (${counts}):`, lines, BACKUP);
}

function fieldNames(scope: string, changes: Record<string, unknown>): string {
  return Object.keys(changes)
    .map((path) => matchDataModelField(scope, path)?.uiLabel ?? pathWords(path))
    .join(", ");
}

/** Item counts in words: "3 income, 12 expenses, 4 accounts". */
function countsText(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([section, count]) => `${count} ${sectionTitle(section).toLowerCase()}`);
  return parts.length > 0 ? parts.join(", ") : "no items";
}

export function clonePlanSummary(input: {
  sourceName: unknown;
  newName: unknown;
  counts: Record<string, number>;
}): string {
  return [
    `Add plan ${quoted(input.newName)} as a copy of ${quoted(input.sourceName)} (${countsText(input.counts)}).`,
    "Current Finances and the other plans are not changed.",
    BACKUP,
  ].join("\n");
}

export function deletePlanSummary(input: {
  planName: unknown;
  counts: Record<string, number>;
}): string {
  return [
    `Delete plan ${quoted(input.planName)} and everything in it (${countsText(input.counts)}).`,
    BACKUP,
  ].join("\n");
}

function keptAccountsLine(kept: readonly unknown[] | undefined): string[] {
  if (!kept || kept.length === 0) return [];
  const names = kept.map((entry) =>
    isPlainObject(entry) ? quoted(entry.name ?? entry.id) : quoted(entry),
  );
  return [
    `Kept as they are (not in the replacement): ${capLines(names, 10).join(", ")}`,
  ];
}

export function restoreCurrentFinancesSummary(input: {
  topLevelKeys: readonly string[];
  keptAccounts?: readonly unknown[];
}): string {
  return render(
    "Replace Current Finances with the supplied data:",
    [
      `Replaced: ${input.topLevelKeys.map((key) => sectionTitle(key)).join(", ") || "nothing"}`,
      ...keptAccountsLine(input.keptAccounts),
    ],
    BACKUP,
  );
}

export function restorePlansSummary(input: {
  currentCount: number;
  incomingCount: number;
  planDiff: readonly {
    name: string;
    status: "unchanged" | "modified" | "added" | "removed";
    changes?: Record<string, string>;
  }[];
}): string {
  const lines = input.planDiff
    .filter((entry) => entry.status !== "unchanged")
    .map((entry) => {
      if (entry.status === "added") return `Add plan ${quoted(entry.name)}`;
      if (entry.status === "removed") return `Remove plan ${quoted(entry.name)}`;
      const parts = Object.entries(entry.changes ?? {}).map(
        ([key, change]) => `${sectionTitle(key).toLowerCase()} ${change}`,
      );
      return `Change plan ${quoted(entry.name)}: ${parts.join("; ")}`;
    });
  const unchanged = input.planDiff.filter((e) => e.status === "unchanged").length;
  if (unchanged > 0) {
    lines.push(
      `${unchanged} other plan${unchanged === 1 ? "" : "s"} replaced, with the same name and item counts`,
    );
  }
  return render(
    `Replace all plans (${input.currentCount} → ${input.incomingCount}):`,
    lines,
    BACKUP,
  );
}

export function restoreSettingsSummary(input: {
  topLevelKeys: readonly string[];
  keptSecrets?: readonly string[];
}): string {
  const lines = [
    `Replaced: ${input.topLevelKeys.map((key) => sectionTitle(key)).join(", ") || "nothing"}`,
  ];
  if (input.keptSecrets && input.keptSecrets.length > 0) {
    lines.push(
      `Kept from the current settings (hidden values): ${input.keptSecrets.map(pathWords).join(", ")}`,
    );
  }
  return render("Replace all Settings with the supplied data:", lines, BACKUP);
}

/** What a backup was taken before, by the operation that took it. */
const OPERATION_WORDS: Record<string, string> = {
  updateAccount: "a Current Finances account change",
  updatePlanEvent: "a plan item change",
  updatePlanSection: "a plan section change",
  updatePlanSettings: "a plan settings change",
  clonePlan: "a plan copy",
  deletePlan: "a plan deletion",
  restoreCurrentFinances: "a Current Finances replacement",
  restorePlans: "a replacement of all plans",
  restoreSettings: "a Settings replacement",
};

function operationText(operation: string): string {
  if (operation.startsWith("rollback_pre_")) return "a rollback";
  return OPERATION_WORDS[operation] ?? `"${words(operation).toLowerCase()}"`;
}

/** A backup's time as a reader names it, in the server's time zone. */
function timeText(timestamp: string): string {
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) return timestamp;
  return time.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function rollbackSummary(input: {
  snapshotId: string;
  timestamp: string;
  operation: string;
  sections: readonly string[];
  keptAccounts?: readonly unknown[];
}): string {
  return render(
    `Restore the backup taken ${timeText(input.timestamp)}, before ${operationText(input.operation)}:`,
    [
      `Restored: ${input.sections.map((section) => sectionTitle(section)).join(", ")}`,
      ...keptAccountsLine(input.keptAccounts),
    ],
    `The current state is backed up first, so this rollback can itself be undone. Backup id: ${input.snapshotId}.`,
  );
}
