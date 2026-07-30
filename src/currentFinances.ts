import { ProjectionLabError } from "./errors.js";
import type { PlanObj } from "./plans.js";

export const CURRENT_FINANCE_COLLECTIONS = [
  "investmentAccounts",
  "savingsAccounts",
  "debts",
  "assets",
] as const;

export interface CurrentFinanceEntry {
  collection: (typeof CURRENT_FINANCE_COLLECTIONS)[number];
  index: number;
  account: PlanObj;
}

export function listCurrentFinanceEntries(
  today: unknown,
): CurrentFinanceEntry[] {
  if (!today || typeof today !== "object" || Array.isArray(today)) return [];
  const root = today as PlanObj;
  const entries: CurrentFinanceEntry[] = [];
  for (const collection of CURRENT_FINANCE_COLLECTIONS) {
    const values = root[collection];
    if (!Array.isArray(values)) continue;
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        entries.push({
          collection,
          index,
          account: value as PlanObj,
        });
      }
    }
  }
  return entries;
}

export function findCurrentFinanceEntry(
  today: unknown,
  accountId: string,
): CurrentFinanceEntry | undefined {
  return listCurrentFinanceEntries(today).find(
    ({ account }) => String(account.id ?? "") === accountId,
  );
}

export function requireCurrentFinances(today: unknown): PlanObj {
  if (!today || typeof today !== "object" || Array.isArray(today)) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      "No current finances data found in ProjectionLab",
      "Set up Current Finances in ProjectionLab first",
    );
  }
  return today as PlanObj;
}

export function currentFinanceAccountNotFoundError(
  today: unknown,
  accountId: string,
): ProjectionLabError {
  const count = listCurrentFinanceEntries(today).length;
  return new ProjectionLabError(
    "INVALID_INPUT",
    `No Current Finances account with ID "${accountId}" found`,
    `Call projectionlab_get_current_finances to inspect the ${count} available account record(s)`,
  );
}
