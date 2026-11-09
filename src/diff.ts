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
import { REDACTED, isSecretFieldName } from "./redact.js";

/**
 * Field-level diff of two readings of ProjectionLab data, shared by
 * projectionlab_diff. It compares the same data at two points in time
 * (`diffSectionData`, `diffPlan`) or two different plans field by field
 * (`diffPlanPair`), where each event's own id is dropped and each reference to
 * another event of the same plan is compared by the event it names. Values
 * render as `before → after` the way `diffFields` renders them, and every path
 * is a dot path in the form `projectionlab_get_plan_section` and the patch
 * tools use (`events.2.amount`), so a reported path can be read back or patched
 * with it.
 *
 * The engine is pure and bounds its own output: `DiffBudget` caps how many
 * field changes and how many list entries one call may report, so the payload
 * stays small enough for a local model to hold in context, and it can ask for
 * the differing paths with the values withheld. Omitted items are counted
 * rather than dropped silently, and whether something counts as changed is
 * decided from the data, never from what was left to report.
 *
 * A change whose path names a credential (`credentials.apiKey`,
 * `access.0.password`) is recorded as `[REDACTED]`, so neither value leaves
 * the process, and a value longer than `MAX_VALUE_CHARS` is truncated with its
 * original length so one long note cannot flood the diff.
 */

/** Field changes one diff reports before it starts omitting. */
export const FIELD_CHANGE_CAP = 200;
/** Added/removed names and ids one diff reports before it starts omitting. */
export const ENTRY_CAP = 200;
/** Serialized values longer than this are truncated in a change entry. */
export const MAX_VALUE_CHARS = 200;

/**
 * Plan fields ProjectionLab computes or re-stamps on its own. Leaving them out
 * is what makes a snapshot-to-live diff of an untouched plan read as clean:
 * saving a plan moves `lastUpdated`, and re-running a simulation rewrites
 * `simKey` and `meta` (same rule as `samePlanContent`).
 */
const COMPUTED_PLAN_FIELDS = ["lastUpdated", "simKey", "meta"] as const;

/**
 * Plan fields that say which plan an object is rather than what it plans. Two
 * plans never share them, so a plan-to-plan comparison leaves them out of the
 * field comparison and reports them as the identity of each side.
 */
const PLAN_IDENTITY_FIELDS = ["id", "name"] as const;

/**
 * How much one diff call reports: how many field changes and how many list
 * entries it may name, and whether it names their values at all. The reporting
 * policy rides with the caps because every comparison thread already carries
 * the budget, so no call site can leak a value by forgetting to pass along a
 * separate flag.
 */
export interface DiffBudget {
  readonly fieldChangeCap: number;
  readonly entryCap: number;
  /** Report only the paths that differ, never their values. */
  readonly pathsOnly: boolean;
  fieldChangesUsed: number;
  entriesUsed: number;
  omittedFieldChanges: number;
  omittedEntries: number;
}

export interface DiffBudgetOptions {
  fieldChangeCap?: number;
  entryCap?: number;
  /** Report only the paths that differ, with no values. */
  pathsOnly?: boolean;
}

export function createDiffBudget(options: DiffBudgetOptions = {}): DiffBudget {
  const {
    fieldChangeCap = FIELD_CHANGE_CAP,
    entryCap = ENTRY_CAP,
    pathsOnly = false,
  } = options;
  return {
    fieldChangeCap,
    entryCap,
    pathsOnly,
    fieldChangesUsed: 0,
    entriesUsed: 0,
    omittedFieldChanges: 0,
    omittedEntries: 0,
  };
}

function isContainer(value: unknown): boolean {
  return !!value && typeof value === "object";
}

function renderValue(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "(absent)";
  if (json.length <= MAX_VALUE_CHARS) return json;
  return `${json.slice(0, MAX_VALUE_CHARS)}...[truncated from ${json.length} characters]`;
}

/**
 * True when any element of a dot path names a credential, so a nested
 * `credentials.apiKey` or `access.0.password` is caught even though the whole
 * path is not a field name. Numeric elements are array positions, not names.
 */
function pathHoldsSecret(path: string): boolean {
  for (const element of path.split(".")) {
    if (/^\d+$/.test(element)) continue;
    if (isSecretFieldName(element)) return true;
  }
  return false;
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

export interface LeafDiff {
  /**
   * The changes the budget had room to record, `path: "before → after"`.
   * Empty when the budget reports paths only.
   */
  changes: Record<string, string>;
  /**
   * The paths the budget had room to record, present only when the budget
   * reports paths only, which is when `changes` stays empty.
   */
  paths?: string[];
  /**
   * Differences found, whether or not the budget had room to record them.
   * Callers decide "modified" from this, never from `changes`, so a difference
   * that falls after the cap is still counted as a change.
   */
  detected: number;
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
): LeafDiff {
  const changes: Record<string, string> = {};
  const paths: string[] | undefined = budget.pathsOnly ? [] : undefined;
  let detected = 0;

  const record = (path: string, from: unknown, to: unknown): void => {
    if (JSON.stringify(from) === JSON.stringify(to)) return;
    detected++;
    if (budget.fieldChangesUsed >= budget.fieldChangeCap) {
      budget.omittedFieldChanges++;
      return;
    }
    budget.fieldChangesUsed++;
    if (paths) {
      paths.push(path);
      return;
    }
    changes[path] = pathHoldsSecret(path)
      ? REDACTED
      : `${renderValue(from)} → ${renderValue(to)}`;
  };

  if (!isContainer(before) && !isContainer(after)) {
    record("(value)", before, after);
    return { changes, ...(paths ? { paths } : {}), detected };
  }

  const beforeLeaves = new Map<string, unknown>();
  const afterLeaves = new Map<string, unknown>();
  walkLeaves(before, "", beforeLeaves);
  walkLeaves(after, "", afterLeaves);
  const allPaths = [
    ...new Set([...beforeLeaves.keys(), ...afterLeaves.keys()]),
  ].sort();
  for (const path of allPaths) {
    record(path, beforeLeaves.get(path), afterLeaves.get(path));
  }
  return { changes, ...(paths ? { paths } : {}), detected };
}

/**
 * The change entry for one event or row: its identity, the field changes the
 * budget recorded (or, when values are withheld, just their paths), and how
 * many more it found than it could record.
 */
function changeEntry<T extends object>(
  identity: T,
  leaf: LeafDiff,
): T & {
  changes?: Record<string, string>;
  paths?: string[];
  omittedChanges?: number;
} {
  const recorded = leaf.paths
    ? leaf.paths.length
    : Object.keys(leaf.changes).length;
  const reported =
    recorded === 0
      ? {}
      : leaf.paths
        ? { paths: leaf.paths }
        : { changes: leaf.changes };
  return {
    ...identity,
    ...reported,
    ...(leaf.detected > recorded
      ? { omittedChanges: leaf.detected - recorded }
      : {}),
  };
}

function isEventish(section: unknown): boolean {
  if (Array.isArray(section)) return true;
  return isContainer(section) && Array.isArray((section as PlanObj).events);
}

export interface ChangeEntry {
  name?: string;
  id?: string;
  changes?: Record<string, string>;
  /** The differing paths, reported instead of `changes` when values are withheld. */
  paths?: string[];
  /** Field changes found for this entry that the cap left out. */
  omittedChanges?: number;
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
  modified?: ChangeEntry[];
  unchangedCount: number;
}

/**
 * One event-shaped section compared between two different plans. Events match
 * by name plus occurrence, so `onlyInA` and `onlyInB` name the events only one
 * of the plans carries, `different` names the shared events whose fields do not
 * match, and `sameCount` counts the events that match field for field.
 */
export interface PairEventDiff {
  kind: "events";
  count: string;
  changed: boolean;
  onlyInACount: number;
  onlyInA?: string[];
  onlyInBCount: number;
  onlyInB?: string[];
  differentCount: number;
  different?: ChangeEntry[];
  sameCount: number;
}

/** What comparing one event-shaped section comes back as, in either mode. */
export type EventCompareDiff = EventSectionDiff | PairEventDiff;

export interface FieldSectionDiff {
  kind: "fields";
  changed: boolean;
  changes?: Record<string, string>;
  /** The differing paths, reported instead of `changes` when values are withheld. */
  paths?: string[];
  /** Field changes found that the cap left out of `changes`. */
  omittedChanges?: number;
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
  const modified: ChangeEntry[] = [];
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
    const leaf = diffLeafValues(previous.event, event, budget);
    if (leaf.detected > 0) {
      modifiedCount++;
      addEntry(modified, changeEntry({ name }, leaf), budget);
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
  const leaf = diffLeafValues(before, after, budget);
  return {
    kind: "fields",
    changed: leaf.detected > 0,
    ...changeEntry({}, leaf),
  };
}

/**
 * Choose how to compare one plan section. A section that is event-shaped on
 * either side compares as events, including one that exists on only one side,
 * so a section added or dropped reads as events appearing or disappearing
 * rather than as a wall of leaf paths. `compareEvents` decides how two sets of
 * events are reported: as added/removed/modified over time, or as
 * onlyInA/onlyInB/different between two plans.
 */
function diffSectionShape<E extends EventCompareDiff>(
  before: unknown,
  after: unknown,
  budget: DiffBudget,
  compareEvents: (
    before: unknown,
    after: unknown,
    budget: DiffBudget,
  ) => E,
): E | FieldSectionDiff {
  const beforeIsEvent = isEventish(before);
  const afterIsEvent = isEventish(after);
  if (beforeIsEvent && afterIsEvent) return compareEvents(before, after, budget);
  if (beforeIsEvent && (after === undefined || after === null)) {
    return compareEvents(before, after, budget);
  }
  if (afterIsEvent && (before === undefined || before === null)) {
    return compareEvents(before, after, budget);
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
  /** The differing paths, reported instead of `changes` when values are withheld. */
  paths?: string[];
  /** Plan setting changes the cap left out of `changes`. */
  omittedChanges?: number;
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
    const result = diffSectionShape(
      before[name],
      after[name],
      budget,
      diffEventSection,
    );
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
  const planFields = diffLeafValues(beforeRest, afterRest, budget);

  return {
    ...planIdentity(after ?? before),
    changed: changedSections.length > 0 || planFields.detected > 0,
    ...changeEntry({}, planFields),
    ...(sectionNames.length > 0 ? { sections } : {}),
    ...(changedSections.length > 0 ? { changedSections } : {}),
  };
}

/**
 * Tokens that name each event of `plan` by its section and display name, keyed
 * by the id that plan's own events use to point at it.
 *
 * Events refer to other events of the same plan by id (`start: { type:
 * "milestone", value: "<milestone id>" }`, a priority's `accountId`), and two
 * plans built independently give the same milestone unrelated ids. Comparing
 * the raw ids would report a difference at every reference of a hand-rebuilt
 * plan; comparing tokens makes a reference to the same-named event compare
 * equal and a reference to a differently named one read as a difference. An id
 * that is not an event of this plan (a Current Finances `accountId`, which
 * every plan shares) gets no token and is compared as it is.
 */
export function eventReferenceTokens(plan: unknown): Map<string, string> {
  const tokens = new Map<string, string>();
  if (!isContainer(plan) || Array.isArray(plan)) return tokens;
  for (const section of Object.keys(plan as PlanObj)) {
    const value = (plan as PlanObj)[section];
    if (!isEventish(value)) continue;
    for (const { name, event } of keyEvents(getEvents(value)).values()) {
      const id = (event as PlanObj | null | undefined)?.id;
      if (id === undefined || id === null || id === "") continue;
      const token = `@${section}:${name}`;
      if (!tokens.has(String(id))) tokens.set(String(id), token);
    }
  }
  return tokens;
}

/** A copy of `value` with each string naming an event of the plan replaced by its token. */
function substituteReferences(
  value: unknown,
  tokens: Map<string, string>,
): unknown {
  if (typeof value === "string") return tokens.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((element) => substituteReferences(element, tokens));
  }
  if (isContainer(value)) {
    const copy: PlanObj = {};
    for (const key of Object.keys(value as PlanObj)) {
      copy[key] = substituteReferences((value as PlanObj)[key], tokens);
    }
    return copy;
  }
  return value;
}

/**
 * One event as plan-to-plan comparison sees it: its own `id` and `key` dropped,
 * references tokened. ProjectionLab gives each event a random `key` when the
 * event is created, so two independently built plans never share it.
 */
function eventForPair(event: unknown, tokens: Map<string, string>): unknown {
  if (Array.isArray(event) || !isContainer(event)) {
    return substituteReferences(event, tokens);
  }
  const copy: PlanObj = {};
  for (const key of Object.keys(event as PlanObj)) {
    if (key === "id" || key === "key") continue;
    copy[key] = substituteReferences((event as PlanObj)[key], tokens);
  }
  return copy;
}

/**
 * One plan section with each event's own `id` and `key` dropped and each
 * reference tokened.
 */
function sectionForPair(section: unknown, tokens: Map<string, string>): unknown {
  if (Array.isArray(section)) {
    return section.map((event) => eventForPair(event, tokens));
  }
  const obj = section as PlanObj;
  if (isContainer(section) && Array.isArray(obj.events)) {
    const copy: PlanObj = {};
    for (const key of Object.keys(obj)) {
      copy[key] =
        key === "events"
          ? obj.events.map((event: unknown) => eventForPair(event, tokens))
          : substituteReferences(obj[key], tokens);
    }
    return copy;
  }
  return substituteReferences(section, tokens);
}

/**
 * One plan reshaped so it can be compared against a different plan: each
 * event's own `id` and `key` is dropped and each reference to another event of
 * the same plan is replaced by that event's token. Those are the only fields
 * two independently built plans of the same content cannot share.
 */
function planForPair(plan: PlanObj): PlanObj {
  const tokens = eventReferenceTokens(plan);
  const prepared: PlanObj = {};
  for (const key of Object.keys(plan)) {
    prepared[key] = sectionForPair(plan[key], tokens);
  }
  return prepared;
}

/**
 * Compare one event-shaped section of two different plans. `a` is plan A and
 * `b` is plan B, so each change reads `A's value → B's value`. Both sides carry
 * the ids and random keys dropped and the references tokened by `planForPair`.
 */
export function diffEventPair(
  a: unknown,
  b: unknown,
  budget: DiffBudget,
): PairEventDiff {
  const aEvents = getEvents(a);
  const bEvents = getEvents(b);
  const aKeyed = keyEvents(aEvents);
  const bKeyed = keyEvents(bEvents);

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const different: ChangeEntry[] = [];
  let onlyInACount = 0;
  let onlyInBCount = 0;
  let differentCount = 0;
  let sameCount = 0;

  for (const [key, { name, event }] of bKeyed) {
    const counterpart = aKeyed.get(key);
    if (!counterpart) {
      onlyInBCount++;
      addEntry(onlyInB, name, budget);
      continue;
    }
    const leaf = diffLeafValues(counterpart.event, event, budget);
    if (leaf.detected > 0) {
      differentCount++;
      addEntry(different, changeEntry({ name }, leaf), budget);
    } else {
      sameCount++;
    }
  }
  for (const [key, { name }] of aKeyed) {
    if (!bKeyed.has(key)) {
      onlyInACount++;
      addEntry(onlyInA, name, budget);
    }
  }

  onlyInA.sort();
  onlyInB.sort();

  return {
    kind: "events",
    count: `${aEvents.length} → ${bEvents.length}`,
    changed: onlyInACount > 0 || onlyInBCount > 0 || differentCount > 0,
    onlyInACount,
    ...(onlyInA.length > 0 ? { onlyInA } : {}),
    onlyInBCount,
    ...(onlyInB.length > 0 ? { onlyInB } : {}),
    differentCount,
    ...(different.length > 0 ? { different } : {}),
    sameCount,
  };
}

export interface PlanPairDiff {
  a: { id: string; name: string };
  b: { id: string; name: string };
  changed: boolean;
  /** The plan's own fields: every field outside the compared sections and outside the computed ones. */
  settings: FieldSectionDiff;
  sections?: Record<string, EventCompareDiff | FieldSectionDiff>;
  changedSections?: string[];
}

/**
 * Compare two different plans field by field, so a plan rebuilt by hand can be
 * checked against the original. Plan A's values are reported first in every
 * `A → B` pair. Events match by name plus occurrence, the same keying the
 * time diff uses; the fields that say which plan an object is (`id`, `name`),
 * the fields ProjectionLab computes (`lastUpdated`, `simKey`, `meta`) and each
 * event's own `id` and randomly assigned `key` are left out, and references
 * between a plan's own events are compared by the event they name. `section`
 * narrows the section comparison; plan settings outside the sections are always
 * compared.
 */
export function diffPlanPair(
  planA: PlanObj,
  planB: PlanObj,
  budget: DiffBudget,
  section?: PlanSection,
): PlanPairDiff {
  const a = planForPair(planA);
  const b = planForPair(planB);

  const sections: Record<string, EventCompareDiff | FieldSectionDiff> = {};
  const changedSections: string[] = [];
  const sectionNames: string[] = section
    ? [section]
    : PLAN_SECTIONS.filter((name) => name in planA || name in planB);

  for (const name of sectionNames) {
    const result = diffSectionShape(a[name], b[name], budget, diffEventPair);
    sections[name] = result;
    if (result.changed) changedSections.push(name);
  }

  const skip = new Set<string>([
    ...PLAN_SECTIONS,
    ...COMPUTED_PLAN_FIELDS,
    ...PLAN_IDENTITY_FIELDS,
  ]);
  const aRest: PlanObj = {};
  const bRest: PlanObj = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.has(key)) continue;
    aRest[key] = a[key];
    bRest[key] = b[key];
  }
  const settings = diffFieldSection(aRest, bRest, budget);

  return {
    a: planIdentity(planA),
    b: planIdentity(planB),
    changed: changedSections.length > 0 || settings.changed,
    settings,
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
  let changedCount = 0;
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
    if (diff.changed) {
      changedCount++;
      addEntry(changedPlans, diff, budget);
    } else {
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
    changed: addedCount > 0 || removedCount > 0 || changedCount > 0,
    planCount: `${beforePlans.length} → ${afterPlans.length}`,
    addedCount,
    ...(added.length > 0 ? { added } : {}),
    removedCount,
    ...(removed.length > 0 ? { removed } : {}),
    changedCount,
    ...(changedPlans.length > 0 ? { changedPlans } : {}),
    unchangedCount,
    ...(unchanged.length > 0 ? { unchanged } : {}),
  };
}

export interface RowDiff extends ChangeEntry {
  id: string;
  name: string;
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
    const leaf = diffLeafValues(previous.row, row, budget);
    if (leaf.detected > 0) {
      modifiedCount++;
      addEntry(modified, changeEntry({ id, name }, leaf), budget);
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
  /** Changes to `today` fields outside the account collections. */
  changes?: Record<string, string>;
  /** The differing paths, reported instead of `changes` when values are withheld. */
  paths?: string[];
  omittedChanges?: number;
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
  const rest = diffLeafValues(beforeRest, afterRest, budget);

  return {
    changed: changed || rest.detected > 0,
    collections,
    ...changeEntry({}, rest),
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
