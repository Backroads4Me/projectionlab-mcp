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
function containsSubset(expected: unknown, actual: unknown): boolean {
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
