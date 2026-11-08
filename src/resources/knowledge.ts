import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const KNOWLEDGE = `# ProjectionLab & FIRE Reference

Curated concepts for analyzing retirement plans through this MCP server.

## How to use this reference

- **Explain, do not recommend.** Say what a term means, what ProjectionLab does
  with it, and what the user can look at in the app to decide. Do not tell the
  user what to do with their money and do not predict a personal outcome. This
  is information and education, not personalized financial advice; the decision
  belongs to the user and a licensed professional.
- **Concepts only; ProjectionLab owns the yearly figures.** The app applies the
  current tax brackets, standard deduction, IRMAA tiers, RMD ages, contribution
  limits and ACA subsidies, and the user sees those numbers in the app (Tax
  Analytics). Never state a yearly figure from memory: they change every year.
  Ask the user to read the current one in ProjectionLab.

## ProjectionLab data model (quick map)

- **plans[]**: each plan is a milestone-driven simulation.
  - **milestones[]**: lifecycle events (retirement, Medicare, death) keyed by
    date/year/milestone-relative criteria. Other events reference milestone IDs.
  - **income.events[]**: salary, Social Security, pension, inheritance; start/end
    reference milestone IDs.
  - **expenses.events[]**: living, travel, healthcare, LTC; carry a
    \`spendingType\` (essential vs discretionary).
  - **accounts.events[]**: investment accounts with \`rothConversions\`
    schedules, withdrawal rules, and bond/equity allocation glidepaths.
  - **assets.events[]**: real estate, vehicles with appreciation/depreciation.
  - **variables**: tax settings, inflation, returns, drawdown order, IRMAA,
    estate config.
  - **withdrawalStrategy**: safe-withdrawal-rate settings, spend mode.
  - **montecarlo**: simulation config (review only; cannot be run remotely).
  - **priorities.events[]**: savings contribution ordering.
- **today / currentFinances**: actual account balances; \`accountId\` links these
  to plan \`accounts.events[]\`.
- Monte Carlo and projection *math* run only in the ProjectionLab UI. This
  server reads/writes the plan definition; it does not compute projections.

## Plan-change outcome metrics

Evaluate a plan change primarily with ProjectionLab's projected ending net worth
and Chance of Success from a completed simulation. Current Finances net worth is
an input balance sheet, not an outcome. Mutation before/after values verify that
the requested input changed; they do not measure its financial impact. The
Plugin API currently does not expose a supported calculation/result method, so
recalculate both outcomes in the UI after applying a change.

## Account tax vocabulary

Use three words for every account, and use them consistently:

- **taxable**: funded with after-tax money; interest, dividends and gains are
  taxed in the year they are received.
- **tax-deferred**: traditional 401(k) and IRA. Contributions lower taxable
  income now; withdrawals are taxed as ordinary income later.
- **tax-free**: Roth accounts, and an HSA spent on healthcare. Qualified
  withdrawals are not taxed.

Do not use "pre-tax" or "post-tax" as account names; they blur the line between
tax-deferred and taxable.

## Core FIRE / decumulation concepts

- **Safe Withdrawal Rate (SWR)**: the share of the portfolio taken out in the
  first year of drawdown. The classic "4% rule" (Trinity study) is a starting
  heuristic for a 30-year horizon, not a guarantee; a longer horizon argues for
  a lower start. The portfolio withdrawal a plan needs falls as guaranteed
  income (Social Security, pension) switches on.
- **Sequence-of-returns risk**: poor returns in the first years of drawdown do
  far more damage than the same returns later. Common mitigations: a cash/bond
  bridge, and a **rising-equity glidepath** ("bond tent" - most bonds at
  retirement, equity rising after).
- **Asset location**: which account holds which asset. A common convention
  places bonds in tax-deferred accounts, high-growth equity in tax-free (Roth,
  HSA) accounts, and tax-efficient equity and cash in taxable. Location changes
  after-tax return without changing the overall allocation.
- **Roth conversion**: moving money from a tax-deferred account into a tax-free
  one. The converted amount is taxed as ordinary income in the year of the
  conversion. A "Roth conversion ladder" converts in low-income years (often
  the window after work ends and before Social Security or RMDs start) to fill
  a low bracket, lower later RMDs, and shrink the taxable estate. Paying that
  year's tax from a taxable account rather than from withholding keeps more
  money inside the tax-free account.

## Tax concepts that gate conversions

Only the shape of each rule is here. ProjectionLab computes with the
current-year figures, and the user reads them in Tax Analytics. MAGI means
modified adjusted gross income; each program (ACA, IRMAA, NIIT) defines it
slightly differently.

- **Federal income tax brackets**: ordinary income is taxed in bands. Income
  that fills an unused low band is cheap; income pushed into the next band
  costs more. What a conversion costs depends on where it lands.
- **ACA premium subsidies**: marketplace health coverage is income-tested. In
  some income ranges extra income can cut a subsidy faster than tax does, so
  the effective marginal rate in those pre-Medicare years is higher than the
  bracket alone suggests. Not a factor with employer, retiree or other
  non-marketplace coverage.
- **IRMAA**: an extra charge on Medicare Part B and Part D premiums. It is set
  by the person's MAGI from two years earlier and comes in tiers, so income
  just over a tier boundary pays the whole higher charge. A conversion in one
  year can raise premiums two years later.
- **NIIT (net investment income tax)**: a surtax on investment income (gains,
  dividends, interest, rent) once MAGI is above an income threshold. It raises
  the cost of a year that mixes a conversion with investment income.
- **Long-term capital gains rate**: while taxable income stays under a
  threshold, long-term gains are taxed at 0%. A low-income year can realize
  some gains at no tax cost before that room is gone.
- **RMDs (Required Minimum Distributions)**: once a person reaches the RMD age,
  tax-deferred accounts require a withdrawal every year, whether or not the
  cash is needed. A large tax-deferred balance can push those forced
  withdrawals into higher brackets and IRMAA tiers, which is the usual reason
  people convert while their income is still low.

## Analysis checklist

1. Build a lifecycle timeline (phase, date range, milestone trigger).
2. Cash flow by phase; flag pure-drawdown years and the gap before Social
   Security starts.
3. Withdrawal rate now and after guaranteed income begins.
4. Sequence risk: what a poor-return start does to the plan. Only a run in the
   ProjectionLab UI can show it.
5. Roth conversion efficiency: bracket headroom versus the ACA, IRMAA and NIIT
   ceilings; compare lifetime taxes and net legacy, not just the tax now.
6. Longevity: does the plan last well past life expectancy?
7. Inflation: healthcare and long-term care costs rise with inflation and are
   often decades out; check how the plan assumes them.

## ProjectionLab help articles

ProjectionLab's own pages, linked for the user and summarized here for a model
with no web access. The bracketed tag is the plan section or area this reference
uses for it. The summaries are ours, not ProjectionLab's wording. Glossary of
financial terms: https://projectionlab.com/financial-terms

- **Withdrawal Strategy mode** [withdrawalStrategy]
  https://projectionlab.com/help/withdrawal-strategy-mode - a comparison mode
  for classic rules (initial percentage, variable percentage withdrawal,
  Guyton-Klinger) that starts at a chosen year or milestone. While it is on,
  its rule replaces most other plan events, so most plans leave it off.
- **Flows, the cash flow priorities** [priorities]
  https://projectionlab.com/help/cash-flow-priorities - Flows decide where
  income goes: savings goals, contributions, extra debt payments, transfers.
  They are handled in the order they were added, so earlier flows are funded
  first. Version 4.6.0 renamed "Priorities" to "Flows".
- **Mandatory goals ("Always Fund")** [priorities]
  https://projectionlab.com/help/mandatory-goals - a flow set to Always Fund is
  funded even when there is no surplus income, by drawing down other accounts.
  It also outranks the other flows.
- **Milestones** [milestones]
  https://projectionlab.com/help/manage-milestones - lifecycle markers
  triggered by age, date, balance, or a combination of criteria; other events
  anchor their start and end to them. Retirement and Life Expectancy cannot be
  deleted.
- **Drawdown order** [variables; the chart is app only]
  https://projectionlab.com/help/drawdown-order-visualization - the order
  accounts are liquidated in to cover a yearly shortfall. The graph and its red
  early-withdrawal penalty line are a UI view of that order.
- **Roth conversions** [accounts; the optimizer is app only]
  https://projectionlab.com/help/roth-conversion - Optimize searches conversion
  strategies against brackets, IRMAA and legacy goals with a beam search, then
  writes the chosen schedule into the plan's accounts. This server can read and
  edit such a schedule; it cannot run the search.
- **Bond allocation and location** [accounts, variables]
  https://projectionlab.com/help/bond-allocation-and-overrides - the bond
  percentage is set plan-wide and can be overridden per account, and the other
  accounts adjust to keep the plan-wide target, with a warning when it cannot
  balance. Bond location chooses which accounts hold bonds first.
- **Custom growth and dividend rates** [accounts]
  https://projectionlab.com/help/growth-dividend-settings-chance-of-success - an
  account's custom growth or dividend rate covers its stock portion; the bond
  portion follows the plan's bond settings unless the account's bond allocation
  is overridden to 0%. In Chance of Success such a rate is either held fixed or
  sampled like the rest of the simulation.
- **IRMAA surcharges** [variables; the optimizer is app only]
  https://projectionlab.com/help/modeling-irmaa-surcharges - tiered Medicare
  Part B and Part D surcharges set by MAGI two years earlier, where crossing a
  tier by any amount costs the whole surcharge. When the user is already on
  Medicare at plan start, ProjectionLab estimates the lookback income for the
  first two plan years.
- **Plan vs Chance of Success** [montecarlo; results are app only]
  https://projectionlab.com/help/plan-vs-chance-of-success - the Plan tab is one
  fixed path at fixed growth; Chance of Success runs many trials over historical
  or randomized market data. All other tabs follow the Plan tab, not the trial
  outcomes.
- **Simulation engine** [app only]
  https://projectionlab.com/help/simulation-engine - the app simulates a full
  year at a time (income, withholding, expenses, debt, dividends, prior-year
  taxes, RMDs) and turns a surplus into savings and a shortfall into
  withdrawals.
- **Flexible spending** [expenses; the feature is app only]
  https://projectionlab.com/help/flex-spending - an optional rule that raises
  or cuts spending with portfolio performance against earlier all-time highs,
  scoped either to all spending or to discretionary expenses only.
- **Plugins and external accounts** [Current Finances; app only]
  https://projectionlab.com/help/plugins - ProjectionLab does not link to banks;
  plugins (Lunch Money, YNAB, Monarch, or your own code) write balances into
  Current Finances through the Plugin API, which has to be enabled in account
  settings. This server uses that same API.
`;

export function registerKnowledgeResource(server: McpServer) {
  server.registerResource(
    "knowledge",
    "projectionlab://knowledge",
    {
      title: "ProjectionLab & FIRE Knowledge",
      description:
        "Curated reference: ProjectionLab data model, FIRE/decumulation concepts, " +
        "retirement tax concepts without yearly figures, an analysis checklist, and an " +
        "index of ProjectionLab help articles. Static; information and education, not " +
        "personalized financial advice.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: KNOWLEDGE,
          mimeType: "text/markdown",
        },
      ],
    }),
  );
}
