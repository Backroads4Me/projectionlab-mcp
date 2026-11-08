import type { PlanObj } from "./plans.js";

/**
 * `type` value that marks a Current Finances `assets` entry as a property.
 * Observed in live exports; the ProjectionLab UI shows these records on the
 * real-estate tile.
 */
const REAL_ESTATE_TYPE = "real-estate";

/**
 * The plan whose values the ProjectionLab UI shows on the property tile: the
 * one flagged `active`, falling back to the first plan.
 */
export function activePlanOf(plans: unknown): PlanObj | null {
  if (!Array.isArray(plans)) return null;
  for (const plan of plans) {
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
      if ((plan as PlanObj).active) return plan as PlanObj;
    }
  }
  const first = plans[0];
  return first && typeof first === "object" && !Array.isArray(first)
    ? (first as PlanObj)
    : null;
}

/**
 * The plan's asset event that back-references a Current Finances asset via
 * `assetId`, or null. Plan asset events are a per-plan overlay on top of the
 * `today.assets` master record.
 */
export function assetEventFor(
  plan: PlanObj | null,
  assetId: unknown,
): PlanObj | null {
  if (!plan || assetId === undefined || assetId === null) return null;
  const assets = plan.assets;
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
    return null;
  }
  const events = (assets as PlanObj).events;
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (event && typeof event === "object" && !Array.isArray(event)) {
      const candidate = event as PlanObj;
      if (
        candidate.assetId !== undefined &&
        candidate.assetId !== null &&
        String(candidate.assetId) === String(assetId)
      ) {
        return candidate;
      }
    }
  }
  return null;
}

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
  const pair = pick(source, [rateKey, rateTypeKey]);
  if (Object.keys(pair).length === 0) return null;
  return { rate: pair[rateKey], rateType: pair[rateTypeKey] };
}

/**
 * Labeled view of a property asset, or null for non-real-estate records.
 *
 * ProjectionLab stores a property's loan balance in `balance` and its market
 * value in `amount`; the block labels both and derives net equity so a
 * reader cannot mistake the loan for the value. Other labels name observed
 * stored fields (meanings beyond `amount`/`balance` are not yet verified
 * against the UI).
 *
 * Field values come from the active plan's asset event when one exists, so
 * the read matches the UI tile; `loanBalance` always comes from the Current
 * Finances record, which is the master record writes target.
 */
export function buildRealEstateBlock(
  asset: PlanObj,
  planEvent: PlanObj | null,
): PlanObj | null {
  if (asset.type !== REAL_ESTATE_TYPE) return null;
  const src = planEvent ?? asset;
  const block: PlanObj = { source: planEvent ? "active-plan-event" : "today-record" };
  if (asset.balance !== undefined) block.loanBalance = asset.balance;
  if (src.amount !== undefined) block.marketValue = src.amount;
  if (typeof src.amount === "number" && typeof asset.balance === "number") {
    block.netEquity = src.amount - asset.balance;
  }
  Object.assign(
    block,
    pick(src, ["paymentMethod", "classification", "excludeLoanFromLNW"]),
  );
  const loan = pick(src, ["interestType", "monthlyPayment", "compounding"]);
  if (src.interestRate !== undefined) loan.apr = src.interestRate;
  if (Object.keys(loan).length > 0) block.loan = loan;
  const propertyTax = ratePair(src, "taxRate", "taxRateType");
  if (propertyTax) block.propertyTax = propertyTax;
  const insurance = ratePair(src, "insuranceRate", "insuranceRateType");
  if (insurance) block.insurance = insurance;
  const maintenance = ratePair(src, "maintenanceRate", "maintenanceRateType");
  if (maintenance) block.maintenance = maintenance;
  const hoa = pick(src, ["monthlyHOA", "monthlyHOAType"]);
  if (Object.keys(hoa).length > 0) {
    block.monthlyHOA = { amount: hoa.monthlyHOA, type: hoa.monthlyHOAType };
  }
  const yearlyChange = src.yearlyChange;
  if (yearlyChange && typeof yearlyChange === "object" && !Array.isArray(yearlyChange)) {
    const change = yearlyChange as PlanObj;
    if (change.amount !== undefined || change.type !== undefined) {
      block.appreciation = { rate: change.amount, type: change.type };
    }
  }
  if (planEvent) {
    const meta = planEvent._meta;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const overridden = (meta as PlanObj).overriddenFields;
      if (overridden && typeof overridden === "object" && !Array.isArray(overridden)) {
        const src2 = overridden as PlanObj;
        block.overriddenFields = Object.keys(src2).filter((k) => src2[k]);
      }
    }
  }
  return block;
}

/**
 * Copy of `today` with a `realEstate` block added to each real-estate asset.
 * The export comes from a shared cache, so entries are only replaced, never
 * mutated in place; the original object is returned unchanged when no asset
 * qualifies.
 */
export function withRealEstateBlocks(
  today: PlanObj,
  plans: unknown,
): PlanObj {
  const assets = today.assets;
  if (!Array.isArray(assets)) return today;
  const active = activePlanOf(plans);
  let changed = false;
  const nextAssets = assets.map((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      return asset;
    }
    const record = asset as PlanObj;
    const block = buildRealEstateBlock(
      record,
      assetEventFor(active, record.id),
    );
    if (!block) return asset;
    changed = true;
    return { ...record, realEstate: block };
  });
  return changed ? { ...today, assets: nextAssets } : today;
}
