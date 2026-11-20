import {
  listV5Accounts,
  v5AccountAmount,
  v5ArchivedStub,
  v5NetWorthContribution,
} from "./currentFinances.js";
import { exportSections } from "./layout.js";
import { planEventCounts, type PlanObj } from "./plans.js";
import { buildRealAssetBlock } from "./realEstate.js";
import type {
  ExportedData,
  FinancialSummary,
  PlanSummary,
} from "./types/projectionlab.js";

type Totals = Record<string, { count: number; total: number }>;

/** A person of a ProjectionLab 5 household, from `household.people`. */
export interface HouseholdPerson {
  /** The `household.people` key: "me" or "spouse". */
  role: string;
  name?: string;
  birthYear?: number;
  birthMonth?: number;
  lifeExpectancy?: number;
}

/** What a ProjectionLab 5 export adds to the summary. */
export interface V5SummaryDetails {
  layout: "v5";
  /** Unarchived accounts grouped by `kind`; debt totals are magnitudes. */
  accountsByKind: Totals;
  /** Unarchived real assets with the equity left after their secured debts. */
  realAssets: PlanObj[];
  /** Archived accounts, left out of every total. */
  archivedAccounts: PlanObj[];
  /** Unarchived accounts of a `kind` this server does not recognize, left out of every total. */
  unrecognizedAccounts: PlanObj[];
  household?: { partnerStatus?: string; people: HouseholdPerson[] };
}

export type CurrentFinancesSummary = FinancialSummary & V5SummaryDetails;

const PLAN_PARAMS = [
  "retirementAge",
  "endAge",
  "lifeExpectancy",
  "startAge",
  "currentAge",
  "withdrawalRate",
  "inflationRate",
];

const isPlainObject = (value: unknown): value is PlanObj =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function addTo(totals: Totals, key: string, amount: number): void {
  const group = (totals[key] ??= { count: 0, total: 0 });
  group.count++;
  group.total += amount;
}

function numberField(source: PlanObj, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The household of a v5 Current Finances document; either person may be absent. */
function summarizeHousehold(
  finances: unknown,
): V5SummaryDetails["household"] {
  const household = isPlainObject(finances) ? finances.household : undefined;
  if (!isPlainObject(household)) return undefined;

  const people: HouseholdPerson[] = [];
  if (isPlainObject(household.people)) {
    for (const role of ["me", "spouse"]) {
      const person = household.people[role];
      if (!isPlainObject(person)) continue;
      const entry: HouseholdPerson = { role };
      if (typeof person.name === "string") entry.name = person.name;
      for (const key of ["birthYear", "birthMonth", "lifeExpectancy"] as const) {
        const value = numberField(person, key);
        if (value !== undefined) entry[key] = value;
      }
      people.push(entry);
    }
  }

  const partnerStatus =
    typeof household.partnerStatus === "string"
      ? household.partnerStatus
      : undefined;
  if (people.length === 0 && partnerStatus === undefined) return undefined;
  return {
    ...(partnerStatus !== undefined ? { partnerStatus } : {}),
    people,
  };
}

/**
 * Net worth and the account breakdown of a ProjectionLab 5 Current Finances
 * document. A "account" adds its balance, a "real-asset" its value and a
 * "debt" subtracts its balance. Archived accounts are listed apart and
 * counted nowhere. Account groups are labeled by the stored `kind` and `type`
 * strings.
 */
function summarizeV5(
  finances: unknown,
): Pick<CurrentFinancesSummary, "totalNetWorth" | "accountsByType"> &
  Omit<V5SummaryDetails, "layout" | "household"> {
  const entries = listV5Accounts(finances);
  const accountsByType: Totals = {};
  const accountsByKind: Totals = {};
  const realAssets: PlanObj[] = [];
  const archivedAccounts: PlanObj[] = [];
  const unrecognizedAccounts: PlanObj[] = [];
  let totalNetWorth = 0;

  for (const entry of entries) {
    if (entry.archived) {
      archivedAccounts.push(v5ArchivedStub(entry));
      continue;
    }
    const contribution = v5NetWorthContribution(entry);
    const amount = v5AccountAmount(entry);
    if (contribution === undefined || amount === undefined) {
      unrecognizedAccounts.push({
        id: entry.id,
        name: entry.name,
        ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      });
      continue;
    }
    totalNetWorth += contribution;
    addTo(accountsByKind, entry.kind as string, amount);
    addTo(accountsByType, `${entry.kind}:${entry.type ?? "unknown"}`, amount);

    const block = buildRealAssetBlock(entry, entries);
    if (block) {
      realAssets.push({
        id: entry.id,
        name: entry.name,
        ...(entry.type !== undefined ? { type: entry.type } : {}),
        ...block,
      });
    }
  }

  return {
    totalNetWorth,
    accountsByType,
    accountsByKind,
    realAssets,
    archivedAccounts,
    unrecognizedAccounts,
  };
}

/**
 * Current Finances totals and the plan inventory, shared by the
 * projectionlab_get_summary tool and the projectionlab://summary resource.
 * Totals come from today's balances, never from projected outcomes.
 */
export function buildSummary(data: ExportedData): CurrentFinancesSummary {
  const sections = exportSections(data);

  const plans: PlanSummary[] = sections.plans.map((p) => {
    const obj = p as Record<string, unknown>;
    const summary: PlanSummary = {
      id: String(obj.id ?? ""),
      name: String(obj.name ?? "unnamed"),
      ...planEventCounts(obj),
    };
    for (const key of PLAN_PARAMS) {
      if (obj[key] !== undefined) {
        summary[key] = obj[key];
      }
    }
    return summary;
  });

  const household = summarizeHousehold(sections.currentFinances);
  const { totalNetWorth, accountsByType, ...details } = summarizeV5(
    sections.currentFinances,
  );
  return {
    scope: "currentFinances",
    projectedOutcomesAvailable: false,
    layout: "v5",
    totalNetWorth,
    accountsByType,
    ...details,
    ...(household ? { household } : {}),
    planCount: plans.length,
    plans,
  };
}
