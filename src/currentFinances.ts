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

const isPlainObject = (value: unknown): value is PlanObj =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * A ProjectionLab 5 Current Finances account (`documents.currentFinances
 * .accounts.<id>`). The `kind` field narrows the record: "account" carries
 * `balance` and `costBasis`, "debt" carries `balance` and optionally
 * `securedByAssetId`, "real-asset" carries `value` and `purchasePrice`.
 * `archivedOn` is present only on archived accounts.
 */
export interface V5AccountEntry {
  /** The record's key in `accounts`. */
  key: string;
  /** The record's own `id`, falling back to its key. */
  id: string;
  name: string;
  kind: string | undefined;
  /** The v5 `type` string, as stored. */
  type: string | undefined;
  archived: boolean;
  account: PlanObj;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * Every account record of a v5 Current Finances document, archived ones
 * included, in stored order. Empty for a v4 `today`, which keeps its accounts
 * in per-type arrays and has no `accounts` object.
 */
export function listV5Accounts(finances: unknown): V5AccountEntry[] {
  const accounts = isPlainObject(finances) ? finances.accounts : undefined;
  if (!isPlainObject(accounts)) return [];
  const entries: V5AccountEntry[] = [];
  for (const [key, value] of Object.entries(accounts)) {
    if (!isPlainObject(value)) continue;
    entries.push({
      key,
      id: nonEmptyString(value.id) ?? key,
      name: nonEmptyString(value.name) ?? "unknown",
      kind: nonEmptyString(value.kind),
      type: nonEmptyString(value.type),
      archived: value.archivedOn !== undefined && value.archivedOn !== null,
      account: value,
    });
  }
  return entries;
}

/** The v5 account with this exact id (or, failing that, key), archived or not. */
export function findV5Account(
  finances: unknown,
  accountId: string,
): V5AccountEntry | undefined {
  const entries = listV5Accounts(finances);
  return (
    entries.find((entry) => entry.id === accountId) ??
    entries.find((entry) => entry.key === accountId)
  );
}

/** A stored number, or 0 for an absent or non-numeric field. */
export function finiteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The size of a v5 account: `value` for a real asset, `balance` for an account
 * and the magnitude of `balance` for a debt. Undefined for a kind this server
 * does not recognize, so its money is reported instead of being silently
 * dropped from totals.
 */
export function v5AccountAmount(entry: V5AccountEntry): number | undefined {
  switch (entry.kind) {
    case "account":
      return finiteNumber(entry.account.balance);
    case "debt":
      return Math.abs(finiteNumber(entry.account.balance));
    case "real-asset":
      return finiteNumber(entry.account.value);
    default:
      return undefined;
  }
}

/**
 * What a v5 account adds to net worth: its balance for an account, its value
 * for a real asset, minus its balance for a debt. Undefined for an
 * unrecognized kind.
 */
export function v5NetWorthContribution(
  entry: V5AccountEntry,
): number | undefined {
  const amount = v5AccountAmount(entry);
  if (amount === undefined) return undefined;
  return entry.kind === "debt" ? -amount : amount;
}

/** The stub that stands in for an archived account in a default listing. */
export function v5ArchivedStub(entry: V5AccountEntry): PlanObj {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    ...(entry.type !== undefined ? { type: entry.type } : {}),
    archivedOn: entry.account.archivedOn,
  };
}

/**
 * Copy of a v5 Current Finances document without its archived accounts, which
 * are listed under `archivedAccounts` instead. Records are only dropped,
 * never mutated, so the cached export stays intact.
 */
export function withoutArchivedAccounts(finances: PlanObj): PlanObj {
  const entries = listV5Accounts(finances);
  const archivedKeys = new Set(
    entries.filter((entry) => entry.archived).map((entry) => entry.key),
  );
  const stored = isPlainObject(finances.accounts) ? finances.accounts : {};
  const accounts = Object.fromEntries(
    Object.entries(stored).filter(([key]) => !archivedKeys.has(key)),
  );
  return {
    ...finances,
    accounts,
    archivedAccounts: entries
      .filter((entry) => entry.archived)
      .map(v5ArchivedStub),
  };
}

export function currentFinanceAccountNotFoundError(
  today: unknown,
  accountId: string,
): ProjectionLabError {
  const count =
    listCurrentFinanceEntries(today).length + listV5Accounts(today).length;
  return new ProjectionLabError(
    "INVALID_INPUT",
    `No Current Finances account with ID "${accountId}" found`,
    `Call projectionlab_get_current_finances to inspect the ${count} available account record(s)`,
  );
}

/** The money fields of a Current Finances account. */
const BALANCE_FIELDS = ["balance", "amount", "value", "costBasis"] as const;

/**
 * The id-bearing accounts of one read, keyed by collection and id. A v5
 * account is keyed under the `accounts` collection, archived ones included.
 */
function accountsById(today: unknown): Map<string, PlanObj> {
  const accounts = new Map<string, PlanObj>();
  for (const entry of listCurrentFinanceEntries(today)) {
    const id = String(entry.account.id ?? "");
    if (id) accounts.set(`${entry.collection} ${id}`, entry.account);
  }
  for (const entry of listV5Accounts(today)) {
    accounts.set(`accounts ${entry.id}`, entry.account);
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
