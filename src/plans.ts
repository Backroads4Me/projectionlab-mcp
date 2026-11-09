import { ProjectionLabError } from "./errors.js";

export type PlanObj = Record<string, unknown>;

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

/**
 * Find a plan by identifier. Match priority: exact ID, exact name
 * (case-insensitive), then partial name. Exact matches win over partial so
 * plans with shared name prefixes can't be silently confused on write paths.
 */
export function findPlanIndex(plans: unknown[], identifier: string): number {
  if (!identifier.trim()) return -1;
  const lower = identifier.toLowerCase();
  let exactName = -1;
  let partial = -1;

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (!plan || typeof plan !== "object") continue;
    const obj = plan as PlanObj;
    if (String(obj.id ?? "") === identifier) return i;
    const name = String(obj.name ?? "").toLowerCase();
    if (name === lower && exactName === -1) exactName = i;
    else if (name.includes(lower) && partial === -1) partial = i;
  }

  return exactName !== -1 ? exactName : partial;
}

export function findPlan(
  plans: unknown[],
  identifier: string,
): PlanObj | null {
  const i = findPlanIndex(plans, identifier);
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

export function requirePlans(data: { plans?: unknown[] }): unknown[] {
  if (!Array.isArray(data.plans) || data.plans.length === 0) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      "No plans found in ProjectionLab",
      "Create a plan in ProjectionLab first",
    );
  }
  return data.plans;
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

/** Index of the event matching `identifier`: exact id, then exact name (case-insensitive), then name substring. -1 if none. */
export function findEventIndex(events: unknown[], identifier: string): number {
  if (!identifier.trim()) return -1;
  const lower = identifier.toLowerCase();
  let exactName = -1;
  let partial = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== "object") continue;
    const obj = e as PlanObj;
    if (String(obj.id ?? "") === identifier) return i;
    const name = String(obj.name ?? "").toLowerCase();
    if (name === lower && exactName === -1) exactName = i;
    else if (name.includes(lower) && partial === -1) partial = i;
  }
  return exactName !== -1 ? exactName : partial;
}

export function eventLabel(event: unknown): string {
  if (event && typeof event === "object") {
    const obj = event as PlanObj;
    return String(obj.name ?? obj.id ?? "unnamed");
  }
  return "unnamed";
}

/**
 * Key events for diffing by label plus occurrence number, so events sharing a
 * name each keep their own entry. Ids are not used because a replacement
 * section may omit them. The display name shows the occurrence only when the
 * label repeats.
 */
export function keyEvents(
  events: unknown[],
): Map<string, { name: string; event: unknown }> {
  const labelCounts = new Map<string, number>();
  for (const e of events) {
    const label = eventLabel(e);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const keyed = new Map<string, { name: string; event: unknown }>();
  for (const e of events) {
    const label = eventLabel(e);
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    const key = `${label}#${n}`;
    const name = (labelCounts.get(label) ?? 0) > 1 ? `${label} #${n}` : label;
    keyed.set(key, { name, event: e });
  }
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

/**
 * True when every leaf value in `expected` is present and equal in `actual`.
 * Tolerates fields ProjectionLab adds on its own (e.g. generated IDs) but
 * catches dropped or changed values. Arrays must match in length and order.
 */
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
