import type { Bridge } from "./bridge.js";
import { ProjectionLabError } from "./errors.js";
import type { PlanObj } from "./plans.js";

/**
 * A plan's version token: its `lastUpdated` stamp, which ProjectionLab sets
 * when the plan is saved. Undefined when the plan carries no stamp.
 */
export function planVersion(plan: unknown): string | undefined {
  if (!plan || typeof plan !== "object") return undefined;
  const stamp = (plan as PlanObj).lastUpdated;
  return stamp === undefined || stamp === null ? undefined : String(stamp);
}

function versionsById(plans: unknown[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const p of plans) {
    if (p && typeof p === "object") {
      out.set(String((p as PlanObj).id ?? ""), planVersion(p));
    }
  }
  return out;
}

/**
 * Describe how `current` differs from `read`: plans added, removed, or saved
 * since `read` was taken. Empty when nothing changed.
 */
export function planChanges(read: unknown[], current: unknown[]): string[] {
  const before = versionsById(read);
  const after = versionsById(current);
  const changes: string[] = [];
  for (const [id, version] of before) {
    if (!after.has(id)) changes.push(`plan ${id} was removed`);
    else if (after.get(id) !== version) changes.push(`plan ${id} was saved`);
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
 * Re-read plans immediately before a whole-array restorePlans write and refuse
 * when any plan was added, removed, or saved since `read`. restorePlans
 * replaces every plan, so writing from a stale read would silently discard an
 * edit made in the ProjectionLab UI in the meantime.
 */
export async function assertPlansUnchanged(
  bridge: Bridge,
  read: unknown[],
): Promise<void> {
  const data = await bridge.exportData({ fresh: true });
  const current = Array.isArray(data.plans) ? data.plans : [];
  const changes = planChanges(read, current);
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
