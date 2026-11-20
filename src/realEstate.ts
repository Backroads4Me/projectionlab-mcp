import type { PlanObj } from "./plans.js";
import {
  finiteNumber,
  listV5Accounts,
  type V5AccountEntry,
} from "./currentFinances.js";

/**
 * Labeled view of a ProjectionLab 5 real asset, or null for any other record.
 *
 * A v5 real asset stores its worth in `value` and its loans as separate debt
 * accounts that name it in `securedByAssetId`. The block gathers the asset's
 * unarchived secured debts and states `equity` as `value` minus their
 * balances: arithmetic on stored fields, not ProjectionLab's own net-worth
 * figure. A debt with no `securedByAssetId` is tied to no asset.
 *
 * `entries` is the whole account list of one Current Finances read.
 */
export function buildRealAssetBlock(
  asset: V5AccountEntry,
  entries: readonly V5AccountEntry[],
): PlanObj | null {
  if (asset.kind !== "real-asset") return null;
  const value = finiteNumber(asset.account.value);
  const securedDebts = entries
    .filter(
      (entry) =>
        entry.kind === "debt" &&
        !entry.archived &&
        (entry.account.securedByAssetId === asset.id ||
          entry.account.securedByAssetId === asset.key),
    )
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      balance: Math.abs(finiteNumber(entry.account.balance)),
    }));
  const loanBalance = securedDebts.reduce((sum, debt) => sum + debt.balance, 0);
  const block: PlanObj = { value };
  if (asset.account.purchasePrice !== undefined) {
    block.purchasePrice = finiteNumber(asset.account.purchasePrice);
  }
  block.loanBalance = loanBalance;
  block.equity = value - loanBalance;
  block.securedDebts = securedDebts;
  return block;
}

/**
 * Copy of a v5 Current Finances document with a `realAsset` block added to
 * each real-asset account. The export comes from a shared cache, so records
 * are only replaced, never mutated in place; the original object is returned
 * unchanged when no real asset qualifies.
 */
export function withRealAssetBlocks(finances: PlanObj): PlanObj {
  const entries = listV5Accounts(finances);
  const accounts = finances.accounts as PlanObj | undefined;
  if (!accounts) return finances;
  let nextAccounts: PlanObj | undefined;
  for (const entry of entries) {
    const block = buildRealAssetBlock(entry, entries);
    if (!block) continue;
    nextAccounts ??= { ...accounts };
    nextAccounts[entry.key] = { ...entry.account, realAsset: block };
  }
  return nextAccounts ? { ...finances, accounts: nextAccounts } : finances;
}
