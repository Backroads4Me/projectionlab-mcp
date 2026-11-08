import type { PlanObj } from "./plans.js";

/**
 * `type` value that marks a Current Finances `assets` entry as a property.
 * Observed in live exports; the ProjectionLab UI shows these records on the
 * real-estate tile.
 */
const REAL_ESTATE_TYPE = "real-estate";

/**
 * `paymentMethod` value under which ProjectionLab records loan terms.
 * Observed in live exports.
 */
const FINANCED = "financed";

function pick(source: PlanObj, keys: string[]): PlanObj {
  const out: PlanObj = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function ratePair(
  source: PlanObj,
  rateKey: string,
  rateTypeKey: string,
): PlanObj | null {
  const pair: PlanObj = {};
  if (source[rateKey] !== undefined) pair.rate = source[rateKey];
  if (source[rateTypeKey] !== undefined) pair.rateType = source[rateTypeKey];
  return Object.keys(pair).length > 0 ? pair : null;
}

/**
 * Labeled view of a property asset, or null for non-real-estate records.
 *
 * ProjectionLab stores a property's loan balance in `balance` and its market
 * value in `amount`; the block labels both so a reader cannot mistake the
 * loan for the value. Labels beyond `amount`/`balance` name observed stored
 * fields whose UI meaning is not yet verified.
 *
 * Values come from the Current Finances record only, the master record
 * writes target. Plan-modeled values (per-plan asset events) are never
 * mixed in; plan-side values are read with projectionlab_get_plan_section
 * on the `assets` section.
 */
export function buildRealEstateBlock(asset: PlanObj): PlanObj | null {
  if (asset.type !== REAL_ESTATE_TYPE) return null;
  const block: PlanObj = {};
  const loanBalance = asset.balance ?? 0;
  block.loanBalance = loanBalance;
  if (asset.amount !== undefined) block.marketValue = asset.amount;
  if (typeof asset.amount === "number" && typeof loanBalance === "number") {
    block.netEquity = asset.amount - loanBalance;
  }
  Object.assign(
    block,
    pick(asset, ["paymentMethod", "classification", "excludeLoanFromLNW"]),
  );
  if (asset.paymentMethod === FINANCED) {
    const loan = pick(asset, [
      "interestType",
      "monthlyPayment",
      "compounding",
    ]);
    if (asset.interestRate !== undefined) loan.apr = asset.interestRate;
    if (Object.keys(loan).length > 0) block.loan = loan;
  }
  const propertyTax = ratePair(asset, "taxRate", "taxRateType");
  if (propertyTax) block.propertyTax = propertyTax;
  const insurance = ratePair(asset, "insuranceRate", "insuranceRateType");
  if (insurance) block.insurance = insurance;
  const maintenance = ratePair(asset, "maintenanceRate", "maintenanceRateType");
  if (maintenance) block.maintenance = maintenance;
  const monthlyHOA: PlanObj = {};
  if (asset.monthlyHOA !== undefined) monthlyHOA.amount = asset.monthlyHOA;
  if (asset.monthlyHOAType !== undefined) monthlyHOA.type = asset.monthlyHOAType;
  if (Object.keys(monthlyHOA).length > 0) block.monthlyHOA = monthlyHOA;
  const yearlyChange = asset.yearlyChange;
  if (
    yearlyChange &&
    typeof yearlyChange === "object" &&
    !Array.isArray(yearlyChange)
  ) {
    const change = yearlyChange as PlanObj;
    const appreciation: PlanObj = {};
    if (change.amount !== undefined) appreciation.rate = change.amount;
    if (change.type !== undefined) appreciation.type = change.type;
    if (Object.keys(appreciation).length > 0) block.appreciation = appreciation;
  }
  return block;
}

/**
 * Copy of `today` with a `realEstate` block added to each real-estate asset.
 * The export comes from a shared cache, so entries are only replaced, never
 * mutated in place; the original object is returned unchanged when no asset
 * qualifies.
 */
export function withRealEstateBlocks(today: PlanObj): PlanObj {
  const assets = today.assets;
  if (!Array.isArray(assets)) return today;
  let changed = false;
  const nextAssets = assets.map((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      return asset;
    }
    const block = buildRealEstateBlock(asset as PlanObj);
    if (!block) return asset;
    changed = true;
    return { ...asset, realEstate: block };
  });
  return changed ? { ...today, assets: nextAssets } : today;
}
