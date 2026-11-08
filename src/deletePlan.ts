import { ProjectionLabError } from "./errors.js";
import { samePlanContent, type PlanObj } from "./plans.js";

function planObjs(plans: unknown[]): PlanObj[] {
  return plans.filter((p): p is PlanObj => !!p && typeof p === "object");
}

function planIdOf(plan: PlanObj): string {
  return String(plan.id ?? "");
}

function availablePlansHint(plans: unknown[]): string {
  const available = planObjs(plans)
    .map((p) => `  - "${String(p.name)}" (${planIdOf(p)})`)
    .join("\n");
  return `Available plans:\n${available}`;
}

/**
 * Check `planId` against `plans` and return the plan it names. Deletion is
 * irreversible from the UI's point of view, so only an exact plan ID matches:
 * names and partial matches are refused. The last remaining plan cannot be
 * deleted.
 */
export function selectPlanForDeletion(
  plans: unknown[],
  planId: string,
): PlanObj {
  const objs = planObjs(plans);
  const target = objs.find((p) => planIdOf(p) === planId);
  if (!target) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `No plan with id "${planId}" found. Deletion takes an exact plan ID, not a name`,
      `${availablePlansHint(plans)}\nPass one of these IDs, taken from projectionlab_describe_schema`,
    );
  }
  // Null and malformed array entries are not plans: only the real plan
  // objects may remain after a delete.
  if (objs.length <= 1) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `Plan "${String(target.name)}" is the only plan; at least one plan must remain`,
      "Delete a different plan, or create another one first (projectionlab_clone_plan can copy one)",
    );
  }
  return target;
}

/** `plans` without the plan whose id equals `planId`; every other entry stays. */
export function withoutPlan(plans: unknown[], planId: string): unknown[] {
  return plans.filter(
    (p) => !(!!p && typeof p === "object" && planIdOf(p as PlanObj) === planId),
  );
}

/**
 * Check a fresh read after removing the plan `deletedId` from `before`: the
 * deleted plan is gone, every other original plan is still present and
 * unsaved, and the count dropped by exactly one. Returns the problems found;
 * empty means verified.
 */
export function verifyPlanDeletion(
  before: unknown[],
  after: unknown[],
  deletedId: string,
): string[] {
  const problems: string[] = [];
  const afterById = new Map<string, PlanObj>();
  for (const p of planObjs(after)) {
    afterById.set(planIdOf(p), p);
  }
  if (afterById.has(deletedId)) {
    problems.push(`deleted plan ${deletedId} is still present`);
  }
  for (const p of planObjs(before)) {
    const id = planIdOf(p);
    if (id === deletedId) continue;
    const post = afterById.get(id);
    if (!post) problems.push(`plan ${id} is missing`);
    else if (!samePlanContent(p, post)) {
      problems.push(`plan ${id} was modified`);
    }
  }
  if (after.length !== before.length - 1) {
    problems.push(
      `plan count is ${after.length}, expected ${before.length - 1}`,
    );
  }
  return problems;
}
