import { randomUUID } from "node:crypto";
import { ProjectionLabError } from "./errors.js";
import type { PlanObj } from "./plans.js";
import { planVersion } from "./planVersion.js";

function maxNumber(values: unknown[]): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number");
  return nums.length === 0 ? undefined : Math.max(...nums);
}

/** True when another plan already uses `name` (case-insensitive, trimmed). */
export function planNameTaken(plans: unknown[], name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return plans.some(
    (p) =>
      !!p &&
      typeof p === "object" &&
      String((p as PlanObj).name ?? "")
        .trim()
        .toLowerCase() === wanted,
  );
}

/**
 * Build a copy of `source` to append to `plans` as a new plan.
 *
 * Event ids are kept as they are. Event ids are scoped to their plan:
 * ProjectionLab's own duplicated plans share every event id, built-in
 * milestones use fixed ids such as "retirement", and events, Monte Carlo
 * settings, the withdrawal strategy and bond account order all reference
 * milestone and account ids within the same plan. Copying them unchanged keeps
 * those references intact.
 *
 * The plan-level identity is replaced: a new id and name, a fresh lastUpdated,
 * inactive, and simKey / meta.index / meta.runKey one past the highest among
 * `plans` so the copy does not collide with an existing plan.
 */
export function buildPlanClone(
  source: PlanObj,
  plans: unknown[],
  newName: string,
  now: number = Date.now(),
): PlanObj {
  const name = newName.trim();
  if (name.length === 0) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      "newName must not be empty",
      "Supply a name for the new plan",
    );
  }
  if (planNameTaken(plans, name)) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `A plan named "${name}" already exists`,
      "Choose a different name for the new plan",
    );
  }

  const objs = plans.filter(
    (p): p is PlanObj => !!p && typeof p === "object",
  );
  const clone = structuredClone(source);
  clone.id = randomUUID();
  clone.name = name;
  clone.lastUpdated = now;
  if ("active" in clone) clone.active = false;

  const simKey = maxNumber(objs.map((p) => p.simKey));
  if (simKey !== undefined) clone.simKey = simKey + 1;

  if (clone.meta && typeof clone.meta === "object") {
    const meta = clone.meta as PlanObj;
    const metas = objs.map((p) => (p.meta ?? {}) as PlanObj);
    const index = maxNumber(metas.map((m) => m.index));
    if (typeof meta.index === "number" && index !== undefined) {
      meta.index = index + 1;
    }
    const runKey = maxNumber(metas.map((m) => m.runKey));
    if (typeof meta.runKey === "number" && runKey !== undefined) {
      meta.runKey = runKey + 1;
    }
  }
  return clone;
}

/**
 * Check a fresh read after appending `clone` to `before`: every original plan
 * is still present and unsaved, and the clone exists exactly once under its
 * name. Returns the problems found; empty means verified.
 */
export function verifyPlanClone(
  before: unknown[],
  after: unknown[],
  clone: PlanObj,
): string[] {
  const problems: string[] = [];
  const afterById = new Map<string, PlanObj>();
  for (const p of after) {
    if (p && typeof p === "object") {
      afterById.set(String((p as PlanObj).id ?? ""), p as PlanObj);
    }
  }
  for (const p of before) {
    if (!p || typeof p !== "object") continue;
    const id = String((p as PlanObj).id ?? "");
    const post = afterById.get(id);
    if (!post) problems.push(`original plan ${id} is missing`);
    else if (planVersion(post) !== planVersion(p)) {
      problems.push(`original plan ${id} was modified`);
    }
  }
  const copies = after.filter(
    (p) => !!p && typeof p === "object" && (p as PlanObj).id === clone.id,
  ) as PlanObj[];
  if (copies.length !== 1) {
    problems.push(`expected the new plan once, found it ${copies.length} times`);
  } else if (copies[0].name !== clone.name) {
    problems.push(`new plan is named "${String(copies[0].name)}", expected "${String(clone.name)}"`);
  }
  if (after.length !== before.length + 1) {
    problems.push(`plan count is ${after.length}, expected ${before.length + 1}`);
  }
  return problems;
}
