import { ProjectionLabError } from "./errors.js";
import { containsSubset, type PlanObj } from "./plans.js";

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

/** The money fields of a Current Finances account. */
const BALANCE_FIELDS = ["balance", "amount", "value", "costBasis"] as const;

/** The id-bearing accounts of one read, keyed by collection and id. */
function accountsById(today: unknown): Map<string, PlanObj> {
  const accounts = new Map<string, PlanObj>();
  for (const entry of listCurrentFinanceEntries(today)) {
    const id = String(entry.account.id ?? "");
    if (id) accounts.set(`${entry.collection} ${id}`, entry.account);
  }
  return accounts;
}

/**
 * Problems for a Current Finances read taken before a write and one taken after
 * it: an id-bearing account the second read dropped or added, and a money field
 * that no longer holds the value the first read saw. Accounts are matched by
 * collection and id, so a reordered list, an account without an id, and a field
 * the first read did not carry never read as a change. A first read that is not
 * an object, or that holds no id-bearing account, has nothing to compare; an
 * id-bearing baseline that the second read does not return as an object is
 * itself the problem.
 */
export function currentFinancesProblems(
  before: unknown,
  after: unknown,
): string[] {
  if (!before || typeof before !== "object" || Array.isArray(before)) return [];
  const beforeAccounts = accountsById(before);
  if (beforeAccounts.size === 0) return [];

  if (!after || typeof after !== "object" || Array.isArray(after)) {
    return ["Current Finances is missing from the re-read"];
  }
  const afterAccounts = accountsById(after);

  const problems: string[] = [];
  for (const [label, account] of beforeAccounts) {
    const current = afterAccounts.get(label);
    if (!current) {
      problems.push(`Current Finances ${label} is missing`);
      continue;
    }
    for (const field of BALANCE_FIELDS) {
      const value = account[field];
      if (value === undefined || value === null) continue;
      const now = current[field];
      if (now === undefined || now === null) {
        problems.push(`Current Finances ${label} lost its ${field}`);
      } else if (!containsSubset(value, now)) {
        problems.push(
          `Current Finances ${label} ${field} changed from ${JSON.stringify(value)} to ${JSON.stringify(now)}`,
        );
      }
    }
  }
  for (const label of afterAccounts.keys()) {
    if (!beforeAccounts.has(label)) {
      problems.push(`Current Finances ${label} was added`);
    }
  }
  return problems;
}
