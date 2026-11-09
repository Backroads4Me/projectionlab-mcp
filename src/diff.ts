import {
  CURRENT_FINANCE_COLLECTIONS,
} from "./currentFinances.js";
import {
  PLAN_SECTIONS,
  eventLabel,
  getEvents,
  keyEvents,
  type PlanObj,
  type PlanSection,
} from "./plans.js";

/**
 * Field-level diff of two copies of the same data, shared by
 * projectionlab_diff. Values render as `before → after` the way
 * `diffFields` renders them, and every path is a dot path in the form
 * `projectionlab_get_plan_section` and the patch tools use (`events.2.amount`),
 * so a reported path can be read back or patched with it.
 *
 * The engine is pure and bounds its own output: `DiffBudget` caps how many
 * field changes and how many list entries one call may report, so the payload
 * stays small enough for a local model to hold in context. Omitted items are
 * counted rather than dropped silently.
 */

/** Field changes one diff reports before it starts omitting. */
export const FIELD_CHANGE_CAP = 200;
/** Added/removed names and ids one diff reports before it starts omitting. */
export const ENTRY_CAP = 200;

/**
 * Plan fields ProjectionLab computes or re-stamps on its own. Leaving them out
 * is what makes a snapshot-to-live diff of an untouched plan read as clean:
 * saving a plan moves `lastUpdated`, and re-running a simulation rewrites
 * `simKey` and `meta` (same rule as `samePlanContent`).
 */
const COMPUTED_PLAN_FIELDS = ["lastUpdated", "simKey", "meta"] as const;

export interface DiffBudget {
  readonly fieldChangeCap: number;
  readonly entryCap: number;
  fieldChangesUsed: number;
  entriesUsed: number;
  omittedFieldChanges: number;
  omittedEntries: number;
}

export function createDiffBudget(
  fieldChangeCap = FIELD_CHANGE_CAP,
  entryCap = ENTRY_CAP,
): DiffBudget {
  return {
    fieldChangeCap,
    entryCap,
    fieldChangesUsed: 0,
    entriesUsed: 0,
    omittedFieldChanges: 0,
    omittedEntries: 0,
  };
}

function isContainer(value: unknown): boolean {
  return !!value && typeof value === "object";
}

function addChange(
  changes: Record<string, string>,
  path: string,
  before: unknown,
  after: unknown,
  budget: DiffBudget,
): void {
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  if (a === b) return;
  if (budget.fieldChangesUsed >= budget.fieldChangeCap) {
    budget.omittedFieldChanges++;
    return;
  }
  budget.fieldChangesUsed++;
  changes[path] = `${a ?? "(absent)"} → ${b ?? "(absent)"}`;
}

/**
 * Record one added/removed entry, unless the entry cap is reached. The caller
 * keeps its own count of what it saw, so a capped list still reports the true
 * count and `omittedEntries` says how many names were left out.
 */
function addEntry<T>(list: T[], entry: T, budget: DiffBudget): void {
  if (budget.entriesUsed >= budget.entryCap) {
    budget.omittedEntries++;
    return;
  }
  budget.entriesUsed++;
  list.push(entry);
}

function walkLeaves(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (prefix) out.set(prefix, []);
      return;
    }
    for (let i = 0; i < value.length; i++) {
      walkLeaves(value[i], prefix ? `${prefix}.${i}` : String(i), out);
    }
    return;
  }
  if (isContainer(value)) {
    const keys = Object.keys(value as PlanObj).sort();
    // An empty container is a leaf, so `{}` versus a value still reads as a
    // change instead of vanishing.
    if (keys.length === 0) {
      if (prefix) out.set(prefix, value);
      return;
    }
    for (const key of keys) {
      walkLeaves(
        (value as PlanObj)[key],
        prefix ? `${prefix}.${key}` : key,
        out,
      );
    }
    return;
  }
  if (prefix) out.set(prefix, value);
}

/**
 * Leaf-by-leaf diff of two values as `path: "before → after"`. Arrays carry
 * their index in the path, so a reordered list reads as changed leaves rather
 * than as nothing.
 */
export function diffLeafValues(
  before: unknown,
  after: unknown,
  budget: DiffBudget,
): Record<string, string> {
  const changes: Record<string, string> = {};
  if (!isContainer(before) && !isContainer(after)) {
    addChange(changes, "(value)", before, after, budget);
    return changes;
  }
  const beforeLeaves = new Map<string, unknown>();
  const afterLeaves = new Map<string, unknown>();
  walkLeaves(before, "", beforeLeaves);
  walkLeaves(after, "", afterLeaves);
  const paths = [
    ...new Set([...beforeLeaves.keys(), ...afterLeaves.keys()]),
  ].sort();
  for (const path of paths) {
    addChange(changes, path, beforeLeaves.get(path), afterLeaves.get(path), budget);
  }
  return changes;
}

function isEventish(section: unknown): boolean {
  if (Array.isArray(section)) return true;
  return isContainer(section) && Array.isArray((section as PlanObj).events);
}

export interface EventSectionDiff {
  kind: "events";
  count: string;
  changed: boolean;
  addedCount: number;
  added?: string[];
  removedCount: number;
  removed?: string[];
  modifiedCount: number;
  modified?: { name: string; changes: Record<string, string> }[];
  unchangedCount: number;
}

export interface FieldSectionDiff {
  kind: "fields";
  changed: boolean;
  changes?: Record<string, string>;
}

/**
 * Diff one plan section. Event-shaped sections (`{ events: [] }`, or a bare
 * array such as `milestones`) compare events by name plus occurrence, the same
 * keying the section dry run uses, so events sharing a name each keep their
 * own entry. Anything else (`variables`, `montecarlo`,
 * `withdrawalStrategy`) compares leaf by leaf.
 */
export function diffEventSection(
  before: unknown,
  after: unknown,
  budget: DiffBudget,
): EventSectionDiff {
  const beforeEvents = getEvents(before);
  const afterEvents = getEvents(after);
  const beforeKeyed = keyEvents(beforeEvents);
  const afterKeyed = keyEvents(afterEvents);

  const added: string[] = [];
  const removed: string[] = [];
  const modified: { name: string; changes: Record<string, string> }[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let modifiedCount = 0;
  let unchangedCount = 0;

  for (const [key, { name, event }] of afterKeyed) {
    const previous = beforeKeyed.get(key);
    if (!previous) {
      addedCount++;
      addEntry(added, name, budget);
      continue;
    }
    const changes = diffLeafValues(previous.event, event, budget);
    if (Object.keys(changes).length > 0) {
      modifiedCount++;
      addEntry(modified, { name, changes }, budget);
    } else {
      unchangedCount++;
    }
  }
  for (const [key, { name }] of beforeKeyed) {
    if (!afterKeyed.has(key)) {
      removedCount++;
      addEntry(removed, name, budget);
    }
  }

  added.sort();
  removed.sort();

  return {
    kind: "events",
    count: `${beforeEvents.length} → ${afterEvents.length}`,
    changed: addedCount > 0 || removedCount > 0 || modifiedCount > 0,
    addedCount,
    ...(added.length > 0 ? { added } : {}),
    removedCount,
    ...(removed.length > 0 ? { removed } : {}),
    modifiedCount,
    ...(modified.length > 0 ? { modified } : {}),
    unchangedCount,
  };
}

/**
 * Diff a data area that holds neither events nor rows: a plan's `variables`,
 * `montecarlo` or `withdrawalStrategy`, and the whole `progress` or `settings`
 * section.
 */
export function diffFieldSection(
  before: unknown,
  after: unknown,
  budget: DiffBudget,
): FieldSectionDiff {
  const changes = diffLeafValues(before, after, budget);
  return {
    kind: "fields",
    changed: Object.keys(changes).length > 0,
    ...(Object.keys(changes).length > 0 ? { changes } : {}),
  };
}

/**
 * Choose how to compare one plan section. A section that is event-shaped on
 * either side compares as events, including one that exists on only one side,
 * so a section added or dropped reads as events appearing or disappearing
 * rather than as a wall of leaf paths.
 */
function diffSectionShape(
  before: unknown,
  after: unknown,
  budget: DiffBudget,
): EventSectionDiff | FieldSectionDiff {
  const beforeIsEvent = isEventish(before);
  const afterIsEvent = isEventish(after);
  if (beforeIsEvent && afterIsEvent) return diffEventSection(before, after, budget);
  if (beforeIsEvent && (after === undefined || after === null)) {
    return diffEventSection(before, after, budget);
  }
  if (afterIsEvent && (before === undefined || before === null)) {
    return diffEventSection(before, after, budget);
  }
  return diffFieldSection(before, after, budget);
}

function planNameOf(plan: unknown): string {
  return String((plan as PlanObj)?.name ?? (plan as PlanObj)?.id ?? "unnamed");
}

/** Match plans across two reads: by id when they carry one, else by name. */
export function planKey(plan: unknown): string {
  const obj = (plan ?? {}) as PlanObj;
  const id = obj.id;
  if (id !== undefined && id !== null && id !== "") return `id:${String(id)}`;
  return `name:${planNameOf(plan)}`;
}

export function planIdentity(plan: unknown): { id: string; name: string } {
  const obj = (plan ?? {}) as PlanObj;
  return {
    id: String(obj.id ?? ""),
    name: String(obj.name ?? "unnamed"),
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface PlanDiff {
  id: string;
  name: string;
  changed: boolean;
  changes?: Record<string, string>;
  sections?: Record<string, EventSectionDiff | FieldSectionDiff>;
  changedSections?: string[];
}

/**
 * Diff two copies of one plan. `section` narrows the comparison to a single
 * plan section; the plan's own settings (every field that is not a known
 * section, such as `retirementAge` or `endAge`) are always compared, minus the
 * computed fields.
 */
export function diffPlan(
  before: PlanObj,
  after: PlanObj,
  budget: DiffBudget,
  section?: PlanSection,
): PlanDiff {
  const sections: Record<string, EventSectionDiff | FieldSectionDiff> = {};
  const changedSections: string[] = [];

  const sectionNames: string[] = section
    ? [section]
    : PLAN_SECTIONS.filter((name) => name in before || name in after);

  for (const name of sectionNames) {
    const result = diffSectionShape(before[name], after[name], budget);
    sections[name] = result;
    if (result.changed) changedSections.push(name);
  }

  // Plan settings are every field that is not a known section and not one of
  // the fields ProjectionLab computes, whatever the section filter is.
  const skip = new Set<string>([...PLAN_SECTIONS, ...COMPUTED_PLAN_FIELDS]);
  const beforeRest: PlanObj = {};
  const afterRest: PlanObj = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (skip.has(key)) continue;
    beforeRest[key] = (before as PlanObj)[key];
    afterRest[key] = (after as PlanObj)[key];
  }
  const changes = diffLeafValues(beforeRest, afterRest, budget);

  const changed =
    changedSections.length > 0 || Object.keys(changes).length > 0;

  return {
    ...planIdentity(after ?? before),
    changed,
    ...(Object.keys(changes).length > 0 ? { changes } : {}),
    ...(sectionNames.length > 0 ? { sections } : {}),
    ...(changedSections.length > 0 ? { changedSections } : {}),
  };
}

export interface PlanListDiff {
  changed: boolean;
  planCount: string;
  addedCount: number;
  added?: { id: string; name: string }[];
  removedCount: number;
  removed?: { id: string; name: string }[];
  changedCount: number;
  changedPlans?: PlanDiff[];
  unchangedCount: number;
  unchanged?: string[];
}

/**
 * Diff two plans arrays. `onlyKey` (from `planKey`) reports one plan alone, so
 * a caller narrowed to a single plan gets just that plan's entry.
 */
export function diffPlanList(
  before: unknown,
  after: unknown,
  budget: DiffBudget,
  options: { section?: PlanSection; onlyKey?: string } = {},
): PlanListDiff {
  const beforePlans = asArray(before);
  const afterPlans = asArray(after);
  const beforeByKey = new Map<string, PlanObj>();
  for (const plan of beforePlans) {
    if (isContainer(plan)) beforeByKey.set(planKey(plan), plan as PlanObj);
  }
  const afterByKey = new Map<string, PlanObj>();
  for (const plan of afterPlans) {
    if (isContainer(plan)) afterByKey.set(planKey(plan), plan as PlanObj);
  }

  const added: { id: string; name: string }[] = [];
  const removed: { id: string; name: string }[] = [];
  const changedPlans: PlanDiff[] = [];
  const unchanged: string[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;

  for (const [key, plan] of afterByKey) {
    if (options.onlyKey && key !== options.onlyKey) continue;
    const previous = beforeByKey.get(key);
    if (!previous) {
      addedCount++;
      addEntry(added, planIdentity(plan), budget);
      continue;
    }
    const diff = diffPlan(previous, plan, budget, options.section);
    if (diff.changed) changedPlans.push(diff);
    else {
      unchangedCount++;
      addEntry(unchanged, diff.name, budget);
    }
  }
  for (const [key, plan] of beforeByKey) {
    if (options.onlyKey && key !== options.onlyKey) continue;
    if (!afterByKey.has(key)) {
      removedCount++;
      addEntry(removed, planIdentity(plan), budget);
    }
  }

  return {
    changed:
      addedCount > 0 || removedCount > 0 || changedPlans.length > 0,
    planCount: `${beforePlans.length} → ${afterPlans.length}`,
    addedCount,
    ...(added.length > 0 ? { added } : {}),
    removedCount,
    ...(removed.length > 0 ? { removed } : {}),
    changedCount: changedPlans.length,
    ...(changedPlans.length > 0 ? { changedPlans } : {}),
    unchangedCount,
    ...(unchanged.length > 0 ? { unchanged } : {}),
  };
}

export interface RowDiff {
  id: string;
  name: string;
  changes: Record<string, string>;
}

export interface CollectionDiff {
  kind: "rows";
  count: string;
  changed: boolean;
  addedCount: number;
  added?: { id: string; name: string }[];
  removedCount: number;
  removed?: { id: string; name: string }[];
  modifiedCount: number;
  modified?: RowDiff[];
  unchangedCount: number;
}

/**
 * Key Current Finances rows for matching: by id when present, since ProjectionLab
 * ids are stable, else by name plus occurrence the way events are keyed.
 */
function keyRows(rows: unknown[]): Map<string, { id: string; name: string; row: unknown }> {
  // Rows without an id keep their own entry under the event keying, which
  // numbers repeated names so two of them can't collapse into one.
  const idlessKeys = [
    ...keyEvents(
      rows.filter((row) => {
        const id = (row ?? {}) as PlanObj;
        return id.id === undefined || id.id === null || id.id === "";
      }),
    ).keys(),
  ];

  const keyed = new Map<string, { id: string; name: string; row: unknown }>();
  let idlessAt = 0;
  for (const row of rows) {
    const obj = (row ?? {}) as PlanObj;
    const id = obj.id;
    if (id !== undefined && id !== null && id !== "") {
      keyed.set(`id:${String(id)}`, {
        id: String(id),
        name: planNameOf(row),
        row,
      });
      continue;
    }
    const key = idlessKeys[idlessAt++];
    keyed.set(key, { id: "", name: planNameOf(row), row });
  }
  return keyed;
}

function diffCollection(
  before: unknown,
  after: unknown,
  budget: DiffBudget,
): CollectionDiff {
  const beforeRows = asArray(before);
  const afterRows = asArray(after);
  const beforeKeyed = keyRows(beforeRows);
  const afterKeyed = keyRows(afterRows);

  const added: { id: string; name: string }[] = [];
  const removed: { id: string; name: string }[] = [];
  const modified: RowDiff[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let modifiedCount = 0;
  let unchangedCount = 0;

  for (const [key, { id, name, row }] of afterKeyed) {
    const previous = beforeKeyed.get(key);
    if (!previous) {
      addedCount++;
      addEntry(added, { id, name }, budget);
      continue;
    }
    const changes = diffLeafValues(previous.row, row, budget);
    if (Object.keys(changes).length > 0) {
      modifiedCount++;
      addEntry(modified, { id, name, changes }, budget);
    } else {
      unchangedCount++;
    }
  }
  for (const [key, { id, name }] of beforeKeyed) {
    if (!afterKeyed.has(key)) {
      removedCount++;
      addEntry(removed, { id, name }, budget);
    }
  }

  return {
    kind: "rows",
    count: `${beforeRows.length} → ${afterRows.length}`,
    changed: addedCount > 0 || removedCount > 0 || modifiedCount > 0,
    addedCount,
    ...(added.length > 0 ? { added } : {}),
    removedCount,
    ...(removed.length > 0 ? { removed } : {}),
    modifiedCount,
    ...(modified.length > 0 ? { modified } : {}),
    unchangedCount,
  };
}

export interface CurrentFinancesDiff {
  changed: boolean;
  collections: Record<string, CollectionDiff>;
  changes?: Record<string, string>;
}

/**
 * Diff Current Finances collection by collection, matching rows by id. Fields
 * outside the account collections (a `today` key that is not one of the four
 * collections) are compared leaf by leaf.
 */
export function diffCurrentFinances(
  before: unknown,
  after: unknown,
  budget: DiffBudget,
): CurrentFinancesDiff {
  const beforeRoot = (isContainer(before) ? before : {}) as PlanObj;
  const afterRoot = (isContainer(after) ? after : {}) as PlanObj;

  const collections: Record<string, CollectionDiff> = {};
  let changed = false;
  for (const collection of CURRENT_FINANCE_COLLECTIONS) {
    if (
      !Array.isArray(beforeRoot[collection]) &&
      !Array.isArray(afterRoot[collection])
    ) {
      continue;
    }
    const result = diffCollection(
      beforeRoot[collection],
      afterRoot[collection],
      budget,
    );
    collections[collection] = result;
    if (result.changed) changed = true;
  }

  const skip = new Set<string>(CURRENT_FINANCE_COLLECTIONS);
  const beforeRest: PlanObj = {};
  const afterRest: PlanObj = {};
  for (const key of new Set([
    ...Object.keys(beforeRoot),
    ...Object.keys(afterRoot),
  ])) {
    if (skip.has(key)) continue;
    beforeRest[key] = beforeRoot[key];
    afterRest[key] = afterRoot[key];
  }
  const changes = diffLeafValues(beforeRest, afterRest, budget);
  if (Object.keys(changes).length > 0) changed = true;

  return {
    changed,
    collections,
    ...(Object.keys(changes).length > 0 ? { changes } : {}),
  };
}

export interface SectionDiffOptions {
  planSection?: PlanSection;
  planOnlyKey?: string;
}

/** Every shape one compared section can come back as; all report `changed`. */
export type SectionDiff =
  | EventSectionDiff
  | FieldSectionDiff
  | CollectionDiff
  | PlanListDiff
  | CurrentFinancesDiff;

/**
 * Diff one snapshot data section (`plans`, `currentFinances`, `progress`,
 * `settings`) by its stored key.
 */
export function diffSectionData(
  section: string,
  before: unknown,
  after: unknown,
  budget: DiffBudget,
  options: SectionDiffOptions = {},
): SectionDiff {
  switch (section) {
    case "plans":
      return diffPlanList(before, after, budget, {
        section: options.planSection,
        onlyKey: options.planOnlyKey,
      });
    case "currentFinances":
      return diffCurrentFinances(before, after, budget);
    default:
      return diffFieldSection(before, after, budget);
  }
}
