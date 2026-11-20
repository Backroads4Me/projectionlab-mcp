import { ProjectionLabError } from "./errors.js";
import { exportSections } from "./layout.js";

export type PlanObj = Record<string, unknown>;

/**
 * The value an output field carries when the export holds nothing for it.
 * A ProjectionLab 5 plan has no `active` flag and its export leaves the
 * workspace's active and baseline plan ids null, so a read reports those as
 * not reported rather than as false or as a plan it picked itself.
 */
export const NOT_REPORTED = "not reported" as const;

export const PLAN_SECTIONS = [
  "income",
  "expenses",
  "accounts",
  "assets",
  "milestones",
  "variables",
  "withdrawalStrategy",
  "montecarlo",
  "priorities",
] as const;

export type PlanSection = (typeof PLAN_SECTIONS)[number];

/** Sections whose members are events addressed by id or name; the
 * settings-like sections use projectionlab_update_plan_settings instead. */
export const EVENT_SECTIONS = [
  "income",
  "expenses",
  "accounts",
  "assets",
  "milestones",
  "priorities",
] as const;

/** The container each section holds, known from its name alone and not from
 * what a plan happens to store: milestones is a direct array, the event
 * sections are objects with an events array, and the settings-like sections
 * are plain objects. Per DATA-MODEL.md sections 5.1 to 5.6 and the
 * `variables`, `montecarlo` and `withdrawalStrategy` field trees. */
export const SECTION_CONTAINERS = {
  income: "events",
  expenses: "events",
  accounts: "events",
  assets: "events",
  milestones: "array",
  variables: "object",
  withdrawalStrategy: "object",
  montecarlo: "object",
  priorities: "events",
} as const satisfies Record<PlanSection, "array" | "events" | "object">;

/**
 * Resolve one identifier against a list of { id, name } items. Match
 * priority: exact ID, then exact name (case-insensitive), then name
 * substring. Anything beyond a single match at the level reached is
 * ambiguous: picking the first would silently target whichever item happens
 * to come first, so the caller must refuse and ask for an exact name or ID.
 */
function matchOne(
  items: unknown[],
  identifier: string,
): { kind: "found"; index: number } | { kind: "none" } | { kind: "ambiguous"; indexes: number[] } {
  if (!identifier.trim()) return { kind: "none" };
  const lower = identifier.toLowerCase();
  const exact: number[] = [];
  const partial: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    const obj = item as PlanObj;
    if (String(obj.id ?? "") === identifier) return { kind: "found", index: i };
    const name = String(obj.name ?? "").toLowerCase();
    if (name === lower) exact.push(i);
    else if (name.includes(lower)) partial.push(i);
  }
  if (exact.length === 1) return { kind: "found", index: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", indexes: exact };
  if (partial.length === 1) return { kind: "found", index: partial[0] };
  if (partial.length > 1) return { kind: "ambiguous", indexes: partial };
  return { kind: "none" };
}

function ambiguousMatchError(
  kind: "plan" | "event",
  identifier: string,
  items: unknown[],
  indexes: number[],
): ProjectionLabError {
  const candidates = indexes
    .map((i) => {
      const obj = items[i] as PlanObj;
      return `  - "${obj.name ?? "(unnamed)"}" (ID: ${obj.id ?? "?"})`;
    })
    .join("\n");
  return new ProjectionLabError(
    "INVALID_INPUT",
    `More than one ${kind} matches "${identifier}"`,
    `Candidates:\n${candidates}\nSupply an exact name or one of the IDs`,
  );
}

/**
 * Index of the plan the identifier names, -1 when nothing matches. Throws
 * INVALID_INPUT when several plans match the same way, so a read and the
 * following write can never target different plans.
 */
export function resolvePlanIndex(plans: unknown[], identifier: string): number {
  const outcome = matchOne(plans, identifier);
  if (outcome.kind === "ambiguous") {
    throw ambiguousMatchError("plan", identifier, plans, outcome.indexes);
  }
  return outcome.kind === "found" ? outcome.index : -1;
}

/** The plan the identifier names, or null when nothing matches. Refuses
 * ambiguous identifiers the way resolvePlanIndex does. */
export function resolvePlan(
  plans: unknown[],
  identifier: string,
): PlanObj | null {
  const i = resolvePlanIndex(plans, identifier);
  return i === -1 ? null : (plans[i] as PlanObj);
}

export function planNotFoundError(
  plans: unknown[],
  identifier: string,
): ProjectionLabError {
  const available = plans
    .map((p) => {
      const obj = p as PlanObj;
      return `  - "${obj.name}" (${obj.id})`;
    })
    .join("\n");
  return new ProjectionLabError(
    "INVALID_INPUT",
    `No plan matching "${identifier}" found`,
    `Available plans:\n${available}`,
  );
}

/**
 * The plans of a raw export, from `documents.plans`. An export with no plans
 * is refused.
 */
export function requirePlans(data: unknown): unknown[] {
  const plans = exportSections(data).plans;
  if (plans.length === 0) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      "No plans found in ProjectionLab",
      "Create a plan in ProjectionLab first",
    );
  }
  return plans;
}

/**
 * Plan names of a raw export, "unnamed" for a plan without one. An export
 * that carries no plans list has no names.
 */
export function exportPlanNames(data: unknown): string[] {
  let plans: unknown[];
  try {
    plans = exportSections(data).plans;
  } catch (err) {
    if (err instanceof ProjectionLabError) return [];
    throw err;
  }
  return plans.map((plan) =>
    String(
      plan && typeof plan === "object"
        ? ((plan as PlanObj).name ?? "unnamed")
        : "unnamed",
    ),
  );
}

/**
 * Extract the events array from a plan section. Most sections are
 * { events: [] }; milestones is a direct array.
 */
export function getEvents(sectionData: unknown): unknown[] {
  if (Array.isArray(sectionData)) return sectionData;
  if (sectionData && typeof sectionData === "object") {
    const events = (sectionData as PlanObj).events;
    if (Array.isArray(events)) return events;
  }
  return [];
}

/** Income, expense and milestone event counts for one plan. */
export function planEventCounts(plan: unknown): {
  incomeCount: number;
  expenseCount: number;
  milestoneCount: number;
} {
  const obj = plan && typeof plan === "object" ? (plan as PlanObj) : {};
  return {
    incomeCount: getEvents(obj.income).length,
    expenseCount: getEvents(obj.expenses).length,
    milestoneCount: getEvents(obj.milestones).length,
  };
}

/** Stable identifier for an event, when it carries one. */
function eventId(event: unknown): string | undefined {
  if (event && typeof event === "object") {
    const id = (event as PlanObj).id;
    if (id !== undefined && id !== null && id !== "") return String(id);
  }
  return undefined;
}

/**
 * Index of the event the identifier names: exact id, then exact name
 * (case-insensitive), then name substring. -1 when nothing matches. Throws
 * INVALID_INPUT when several events match the same way.
 */
export function resolveEventIndex(
  events: unknown[],
  identifier: string,
): number {
  const outcome = matchOne(events, identifier);
  if (outcome.kind === "ambiguous") {
    throw ambiguousMatchError("event", identifier, events, outcome.indexes);
  }
  return outcome.kind === "found" ? outcome.index : -1;
}

/**
 * Index of the event linked to the Current Finances account or asset the
 * identifier names, -1 when none is. A ProjectionLab 5 plan event refers to
 * its account by `accountId` and to its asset by `assetId`, and its own `id`
 * is distinct. Throws INVALID_INPUT when several events link the same one.
 */
export function resolveLinkedEventIndex(
  events: unknown[],
  identifier: string,
): number {
  const indexes: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event || typeof event !== "object") continue;
    const obj = event as PlanObj;
    if (obj.accountId === identifier || obj.assetId === identifier) {
      indexes.push(i);
    }
  }
  if (indexes.length > 1) {
    throw ambiguousMatchError("event", identifier, events, indexes);
  }
  return indexes.length === 1 ? indexes[0] : -1;
}

export function eventLabel(event: unknown): string {
  if (event && typeof event === "object") {
    const obj = event as PlanObj;
    return String(obj.name ?? obj.id ?? "unnamed");
  }
  return "unnamed";
}

/** Milestone names by id, from a plan's `milestones` section. */
export function milestoneNames(plan: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!plan || typeof plan !== "object") return names;
  for (const m of getEvents((plan as PlanObj).milestones)) {
    if (!m || typeof m !== "object") continue;
    const { id, name } = m as PlanObj;
    if (typeof id === "string" && id !== "" && typeof name === "string" && name !== "") {
      names.set(id, name);
    }
  }
  return names;
}

/** The prefix plan-to-plan comparison gives a reference to a milestone. */
const MILESTONE_TOKEN_PREFIX = "@milestones:";

/**
 * When an event starts, in the words a user names it by: a milestone's name,
 * a date, year or keyword as stored, or an age. A milestone id resolves
 * through `milestones`, and a plan-to-plan reference token
 * (`@milestones:<name>`) through its name. Undefined when the event has no
 * start.
 */
export function startLabel(
  start: unknown,
  milestones: ReadonlyMap<string, string>,
): string | undefined {
  if (!start || typeof start !== "object" || Array.isArray(start)) return undefined;
  const { type, value, modifier } = start as PlanObj;
  const text =
    value === undefined || value === null || value === "" ? undefined : String(value);
  switch (type) {
    case "date":
    case "year":
    case "keyword":
      return text;
    case "age":
      return text === undefined ? undefined : `age ${text}`;
    case "milestone": {
      if (text === undefined) return undefined;
      const name =
        milestones.get(text) ??
        (text.startsWith(MILESTONE_TOKEN_PREFIX)
          ? text.slice(MILESTONE_TOKEN_PREFIX.length)
          : text);
      return typeof modifier === "number" && modifier !== 0
        ? `${name} ${modifier > 0 ? "+" : ""}${modifier}`
        : name;
    }
    case "lifeExpectancy":
      return "life expectancy";
    case "lastLifeExpectancy":
      return "last life expectancy";
    default:
      return undefined;
  }
}

/**
 * Display names for a list of events, in order. A label used once stays as it
 * is. With `milestones`, a repeated label carries its start, as in
 * "Travel (starts Stop RV life)", and falls back to "Travel #2" (its
 * occurrence among the events of that label) when it has no start or shares
 * its start with another of them. Without `milestones`, every repeated label
 * takes the occurrence.
 */
export function eventDisplayNames(
  events: readonly unknown[],
  milestones?: ReadonlyMap<string, string>,
): string[] {
  const labels = events.map(eventLabel);
  const starts = events.map((e) =>
    milestones && e && typeof e === "object"
      ? startLabel((e as PlanObj).start, milestones)
      : undefined,
  );
  const labelCounts = new Map<string, number>();
  const startCounts = new Map<string, number>();
  labels.forEach((label, i) => {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    if (starts[i] !== undefined) {
      const key = JSON.stringify([label, starts[i]]);
      startCounts.set(key, (startCounts.get(key) ?? 0) + 1);
    }
  });
  const seen = new Map<string, number>();
  return labels.map((label, i) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    if ((labelCounts.get(label) ?? 0) <= 1) return label;
    const start = starts[i];
    if (start !== undefined && startCounts.get(JSON.stringify([label, start])) === 1) {
      return `${label} (starts ${start})`;
    }
    return `${label} #${n}`;
  });
}

/**
 * Key events for diffing by label plus occurrence number, so events sharing a
 * name each keep their own entry. Ids are not used because a replacement
 * section may omit them. The display names come from `eventDisplayNames`;
 * passing `milestones` names repeated labels by their start.
 */
export function keyEvents(
  events: unknown[],
  milestones?: ReadonlyMap<string, string>,
): Map<string, { name: string; event: unknown }> {
  const names = eventDisplayNames(events, milestones);
  const seen = new Map<string, number>();
  const keyed = new Map<string, { name: string; event: unknown }>();
  events.forEach((e, i) => {
    const label = eventLabel(e);
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    keyed.set(`${label}#${n}`, { name: names[i], event: e });
  });
  return keyed;
}

function sectionIsEventBased(section: unknown): boolean {
  if (Array.isArray(section)) return true;
  return (
    !!section &&
    typeof section === "object" &&
    Array.isArray((section as PlanObj).events)
  );
}

function isPlainSectionObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The container kind of a section value, or null when it is not a usable
 * container (null, undefined, a primitive, or a non-plain object). */
export function sectionContainer(
  value: unknown,
): "array" | "events" | "object" | null {
  if (Array.isArray(value)) return "array";
  if (isPlainSectionObject(value)) {
    return Array.isArray((value as PlanObj).events) ? "events" : "object";
  }
  return null;
}

const CONTAINER_WORDS = {
  array: "an array of events",
  events: "an object with an events array",
  object: "an object",
} as const;

/**
 * Refuse sectionData whose container shape does not match the section named.
 * The expected container comes from the section's name, not from what the
 * plan currently stores, so an event section held as {} still accepts the
 * correct { events: [...] } replacement. One exception: when the stored
 * section is itself a usable container that contradicts the table, a
 * replacement in the stored shape is accepted too, so the tool never refuses
 * to write back what it just read. An omitted value would delete the
 * section, and a container of the wrong kind would store data ProjectionLab
 * cannot read.
 */
export function assertSectionShape(
  section: string,
  planName: string,
  current: unknown,
  incoming: unknown,
): void {
  const incomingShape = sectionContainer(incoming);
  if (incomingShape === null) {
    const got =
      incoming === undefined
        ? "missing"
        : incoming === null
          ? "null"
          : Array.isArray(incoming)
            ? "an array"
            : typeof incoming;
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `sectionData for "${section}" of plan "${planName}" is ${got}; a section is ${CONTAINER_WORDS.array} or ${CONTAINER_WORDS.object}`,
      "Send the complete section in the same shape projectionlab_get_plan_section returns: an array for milestones, an object with an events array for event sections, an object for settings-like sections",
    );
  }
  const expected = SECTION_CONTAINERS[section as PlanSection];
  const accepted = new Set<"array" | "events" | "object">([expected]);
  const currentShape = sectionContainer(current);
  if (currentShape !== null && currentShape !== expected) accepted.add(currentShape);
  if (!accepted.has(incomingShape)) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `sectionData for "${section}" of plan "${planName}" must be ${CONTAINER_WORDS[expected]}, which is how this section is stored; received ${CONTAINER_WORDS[incomingShape]}`,
      `Read the section with projectionlab_get_plan_section and send the replacement in the container shape the section name calls for`,
    );
  }
}

/**
 * True when every value in `expected` is present and equal in `actual`.
 * Objects may carry extra keys; arrays must match in length and order.
 */
export function containsSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    return JSON.stringify(expected) === JSON.stringify(actual);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((v, i) => containsSubset(v, actual[i]));
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const a = actual as PlanObj;
  return Object.keys(expected as PlanObj).every((k) =>
    containsSubset((expected as PlanObj)[k], a[k]),
  );
}

/**
 * Verify a section write actually took effect by comparing what we submitted
 * against a fresh read - not just event counts. For event-based sections it
 * checks the count, that every submitted event (by name/id) is present, and
 * that each submitted event's values survived. For non-event sections
 * (variables, montecarlo, …) it compares the whole submitted object, so a
 * zero-vs-zero count can no longer pass as "verified".
 */
export function verifySectionApplied(
  submitted: unknown,
  actual: unknown,
): { ok: boolean; reason?: string } {
  if (sectionIsEventBased(submitted)) {
    const sub = getEvents(submitted);
    const act = getEvents(actual);
    if (sub.length !== act.length) {
      return { ok: false, reason: `event count ${act.length} != submitted ${sub.length}` };
    }
    // Match one-to-one, consuming each actual event so duplicates can't both
    // verify against the same entry. Prefer matching by id (stable); fall back
    // to name, and require the values to survive so a corrupted duplicate has
    // no intact partner to match.
    const remaining = [...act];
    for (const e of sub) {
      const id = eventId(e);
      let idx =
        id !== undefined ? remaining.findIndex((a) => eventId(a) === id) : -1;
      if (idx === -1) {
        idx = remaining.findIndex(
          (a) => eventLabel(a) === eventLabel(e) && containsSubset(e, a),
        );
      }
      if (idx === -1) {
        return {
          ok: false,
          reason: `event "${eventLabel(e)}" missing or changed after write`,
        };
      }
      // When matched by id, still confirm the values landed.
      if (!containsSubset(e, remaining[idx])) {
        return { ok: false, reason: `event "${eventLabel(e)}" values changed after write` };
      }
      remaining.splice(idx, 1);
    }
    return { ok: true };
  }
  if (!containsSubset(submitted, actual)) {
    return { ok: false, reason: "section values differ from what was submitted" };
  }
  return { ok: true };
}

/**
 * True when `after` still holds every input value of `before`.
 * `lastUpdated`, `simKey`, and `meta` are left out: ProjectionLab saves every
 * plan on array replacement and re-runs simulations, which may re-stamp
 * lastUpdated and update computed fields (simKey, meta.runKey,
 * meta.yearlySummary) on untouched plans.
 */
export function samePlanContent(before: PlanObj, after: PlanObj): boolean {
  const { lastUpdated: _stamp, simKey: _key, meta: _meta, ...content } = before;
  return containsSubset(content, after);
}

/**
 * Checks on a plan a write did not target, beyond its input content: its
 * `lastUpdated` stamp may move forward (restorePlans saves every plan) but may
 * not go backwards or disappear, and a `simKey` it carried may change value
 * (ProjectionLab re-runs the plan open in the tab) but may not disappear. A
 * plan that carried no simKey, or a stamp that is not a number on either side,
 * is not reported, so absent fields never read as a change. `label` names the
 * plan in each problem, for example `original plan p1`.
 */
export function keptPlanIdentityProblems(
  label: string,
  before: PlanObj,
  after: PlanObj,
): string[] {
  const problems: string[] = [];
  const simKey = before.simKey;
  if (simKey !== undefined && simKey !== null) {
    const current = after.simKey;
    if (current === undefined || current === null) {
      problems.push(`${label} lost its simKey`);
    }
  }
  const was = before.lastUpdated;
  const now = after.lastUpdated;
  if (was !== undefined && was !== null) {
    if (now === undefined || now === null) {
      problems.push(`${label} lost its lastUpdated`);
    } else if (
      typeof was === "number" &&
      typeof now === "number" &&
      now < was
    ) {
      problems.push(`${label} lastUpdated moved backwards from ${was} to ${now}`);
    }
  }
  return problems;
}

/** Field-by-field diff of two objects; values rendered as "from → to". */
export function diffFields(
  current: unknown,
  incoming: unknown,
): Record<string, string> {
  const cur = (current ?? {}) as PlanObj;
  const inc = (incoming ?? {}) as PlanObj;
  const changes: Record<string, string> = {};
  for (const key of new Set([...Object.keys(cur), ...Object.keys(inc)])) {
    const a = JSON.stringify(cur[key]);
    const b = JSON.stringify(inc[key]);
    if (a !== b) {
      changes[key] = `${a ?? "(absent)"} → ${b ?? "(absent)"}`;
    }
  }
  return changes;
}
