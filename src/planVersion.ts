import type { Bridge } from "./bridge.js";
import { ProjectionLabError } from "./errors.js";
import { samePlanContent, type PlanObj } from "./plans.js";
import { exportSections } from "./layout.js";

/**
 * A plan's version token: its `lastUpdated` stamp, which ProjectionLab sets
 * when the plan is saved. Undefined when the plan carries no stamp.
 */
export function planVersion(plan: unknown): string | undefined {
  if (!plan || typeof plan !== "object") return undefined;
  const stamp = (plan as PlanObj).lastUpdated;
  return stamp === undefined || stamp === null ? undefined : String(stamp);
}

function plansById(plans: unknown[]): Map<string, PlanObj> {
  const out = new Map<string, PlanObj>();
  for (const p of plans) {
    if (p && typeof p === "object") {
      out.set(String((p as PlanObj).id ?? ""), p as PlanObj);
    }
  }
  return out;
}

/**
 * Describe how `current` differs from `read`: plans added, removed, saved, or
 * changed since `read` was taken. Empty when nothing changed.
 *
 * A plan's `lastUpdated` stamp decides when both reads carry one;
 * ProjectionLab moves it each time it saves the plan. A plan with no stamp
 * on either read has no version to compare, so its input content is compared
 * in both directions instead (computed fields left out, see samePlanContent).
 */
export function planChanges(read: unknown[], current: unknown[]): string[] {
  const before = plansById(read);
  const after = plansById(current);
  const changes: string[] = [];
  for (const [id, plan] of before) {
    const now = after.get(id);
    if (!now) {
      changes.push(`plan ${id} was removed`);
      continue;
    }
    const was = planVersion(plan);
    const is = planVersion(now);
    if (was !== is) {
      changes.push(`plan ${id} was saved`);
    } else if (
      was === undefined &&
      !(samePlanContent(plan, now) && samePlanContent(now, plan))
    ) {
      changes.push(`plan ${id} was changed`);
    }
  }
  for (const id of after.keys()) {
    if (!before.has(id)) changes.push(`plan ${id} was added`);
  }
  return changes;
}

export function planConflictError(changes: string[]): ProjectionLabError {
  return new ProjectionLabError(
    "PLAN_CONFLICT",
    `Plans changed in ProjectionLab after they were read (${changes.join("; ")}). Nothing was written.`,
    "Re-run the tool without confirm to preview against the latest data, then confirm again",
  );
}

/**
 * Re-read plans and refuse when any plan was added, removed, or saved since
 * `read`. restorePlans replaces every plan, so writing from a stale read
 * would silently discard an edit made in the meantime. Other operations can
 * run between this check and a later write, so the write itself goes through
 * Bridge.restorePlansIfUnchanged; this check is for refusing early, before a
 * multi-section write applies anything.
 */
export async function assertPlansUnchanged(
  bridge: Bridge,
  read: unknown[],
): Promise<void> {
  const data = await bridge.exportData({ fresh: true });
  const changes = planChanges(read, exportSections(data).plans);
  if (changes.length > 0) throw planConflictError(changes);
}

/**
 * Refuse when the caller previewed a plan at `expected` and it has been saved
 * since. Used to carry a dry-run's version into the confirming call.
 */
export function assertPlanVersion(
  plan: unknown,
  expected: string | undefined,
): void {
  if (expected === undefined) return;
  const actual = planVersion(plan);
  if (actual !== expected) {
    const id = String((plan as PlanObj).id ?? "");
    throw planConflictError([
      `plan ${id} is at version ${actual ?? "(none)"}, preview was ${expected}`,
    ]);
  }
}
