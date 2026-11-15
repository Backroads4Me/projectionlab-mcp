// A synthetic ProjectionLab 5 export (Plugin API contract 2). Every name, id
// and amount is invented. Paths, value types, and the `type`/`kind` values
// follow the v5 export structure baseline; fields the baseline records only
// as a type (partnerStatus, withdraw) carry placeholder strings. The layout:
// one envelope whose documents each carry their own schema, accounts keyed
// by id and narrowed by `kind`, `archivedOn` present only on archived
// accounts, and loans as debt accounts linked to the asset they secure
// through `securedByAssetId` (ProjectionLab Plugin API reference, V5).

export const V5_SCHEMA = 5;

export function v5Export() {
  return {
    schema: 1,
    exportedAt: 1_700_000_000_000,
    documents: {
      currentFinances: {
        schema: V5_SCHEMA,
        lastUpdated: 1_700_000_000_000,
        location: { country: "US", state: "CO" },
        household: {
          partnerStatus: "placeholder",
          people: {
            me: { id: "me", name: "Alex", birthYear: 1980, birthMonth: 4, lifeExpectancy: 95, color: "blue", icon: "person", character: {} },
            spouse: { id: "spouse", name: "Sam", birthYear: 1982, birthMonth: 9, lifeExpectancy: 95, color: "green", icon: "person", character: {} },
          },
        },
        accounts: {
          acct_brokerage: {
            id: "acct_brokerage", name: "Brokerage", kind: "account", type: "taxable",
            owner: "me", order: 0, icon: "chart", balance: 50_000, costBasis: 40_000,
          },
          acct_401k: {
            id: "acct_401k", name: "Work 401k", kind: "account", type: "401k",
            owner: "me", order: 1, icon: "bank", balance: 20_000, costBasis: 0,
          },
          acct_old_savings: {
            id: "acct_old_savings", name: "Old Savings", kind: "account", type: "savings",
            owner: "me", order: 2, icon: "bank", archivedOn: "2025-06-01", balance: 0, costBasis: 0,
          },
          asset_land: {
            id: "asset_land", name: "Land", kind: "real-asset", type: "land", subtype: "lot",
            owner: "joint", order: 3, icon: "home", value: 120_000, purchasePrice: 100_000,
          },
          debt_land_loan: {
            id: "debt_land_loan", name: "Land Loan", kind: "debt", type: "secured-loan",
            owner: "joint", order: 4, icon: "loan", balance: 60_000, securedByAssetId: "asset_land",
          },
        },
      },
      plans: [v5Plan("plan_main", "Main Plan", 0), v5Plan("plan_early", "Retire Early", 1)],
      settings: {
        schema: V5_SCHEMA,
        seenVersion: "5.0.0",
        plan: { activeId: null, baselineId: null, alignment: { type: "calendar" }, tabs: { pinned: false } },
        plugins: { enabled: true, apiKey: "synthetic-plugin-key" },
      },
      accountHistory: {
        acct_brokerage: {
          2025: { schema: V5_SCHEMA, kind: "account", balance: { acct_brokerage: 45_000 }, costBasis: { acct_brokerage: 38_000 } },
        },
        asset_land: {
          2025: { schema: V5_SCHEMA, kind: "real-asset", value: { asset_land: 115_000 } },
        },
      },
    },
  };
}

function v5Plan(id, name, index) {
  const at = (value) => ({ type: "date", value });
  return {
    schema: V5_SCHEMA,
    id,
    name,
    icon: "flag",
    lastUpdated: 1_700_000_000_000 + index,
    meta: { index, hasAddedPriorities: true },
    startingConditionsType: "currentFinances",
    startingConditions: {},
    variables: {},
    montecarlo: {},
    withdrawalStrategy: {},
    milestones: [{ id: `${id}_ms_retire`, name: "Retirement" }],
    accounts: {
      events: [
        { id: `${id}_ev_brokerage`, accountId: "acct_brokerage", kind: "account", type: "taxable", name: "Brokerage", liquidity: true, withdraw: "placeholder" },
      ],
    },
    assets: {
      events: [
        {
          id: `${id}_ev_land`, assetId: "asset_land", kind: "real-asset", type: "land", name: "Land", subtype: "lot",
          value: 120_000, valueType: "placeholder", purchasePrice: 100_000, purchasePriceType: "placeholder",
          loans: [],
        },
      ],
    },
    income: { events: [{ id: `${id}_ev_salary`, kind: "income", type: "other", name: "Salary", amount: 90_000, start: at("2026-01-01"), end: { type: "milestone", value: `${id}_ms_retire` } }] },
    expenses: { events: [{ id: `${id}_ev_living`, kind: "expense", type: "living-expenses", name: "Living", amount: 50_000, start: at("2026-01-01"), end: { type: "keyword", value: "placeholder" } }] },
    priorities: { events: [{ id: `${id}_ev_save`, kind: "priority", type: "taxable", name: "Save to brokerage", accountId: "acct_brokerage" }] },
  };
}
