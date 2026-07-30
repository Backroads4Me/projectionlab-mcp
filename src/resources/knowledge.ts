import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const KNOWLEDGE = `# ProjectionLab & FIRE Reference

Curated concepts for analyzing retirement plans through this MCP server.
Educational only — not financial advice. Always verify current-year tax figures
via web search; they change annually.

## ProjectionLab data model (quick map)

- **plans[]** — each plan is a milestone-driven simulation.
  - **milestones[]** — lifecycle events (retirement, Medicare, death) keyed by
    date/year/milestone-relative criteria. Other events reference milestone IDs.
  - **income.events[]** — salary, Social Security, pension, inheritance; start/end
    reference milestone IDs.
  - **expenses.events[]** — living, travel, healthcare, LTC; carry a
    \`spendingType\` (essential vs discretionary).
  - **accounts.events[]** — investment accounts with \`rothConversions\`
    schedules, withdrawal rules, and bond/equity allocation glidepaths.
  - **assets.events[]** — real estate, vehicles with appreciation/depreciation.
  - **variables** — tax settings, inflation, returns, drawdown order, IRMAA,
    estate config.
  - **withdrawalStrategy** — safe-withdrawal-rate settings, spend mode.
  - **montecarlo** — simulation config (review only; cannot be run remotely).
  - **priorities.events[]** — savings contribution ordering.
- **today / currentFinances** — actual account balances; \`accountId\` links these
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

## Core FIRE / decumulation concepts

- **Safe Withdrawal Rate (SWR)** — the classic "4% rule" (Trinity study) is a
  starting heuristic for a 30-yr horizon; longer horizons or rich valuations
  argue for ~3.0–3.5%. Withdrawal rate falls as guaranteed income (Social
  Security, pension) switches on.
- **Sequence-of-returns risk** — poor returns in the *first* years of drawdown
  do far more damage than the same returns later. Mitigants: a cash/bond bridge,
  and a **rising-equity glidepath** ("bond tent" — most bonds at retirement,
  equity rising after).
- **Asset location** — hold bonds in tax-deferred (traditional), high-growth
  equity in Roth/HSA (tax-free), and tax-efficient equity/cash in taxable.
  Improves after-tax returns without changing the overall allocation.
- **Roth conversion ladder** — convert traditional → Roth in lower-income years
  (typically the pre-Social-Security / pre-RMD window) to fill a target bracket,
  reduce future RMDs, and shrink the taxable estate. Pay the tax from *taxable*,
  not from withholding, so every dollar converted reaches the Roth.

## Tax landmarks that gate conversions (verify current-year values!)

- **Federal brackets** — common conversion targets are the top of the 22% or 24%
  bracket.
- **ACA premium subsidies** — a MAGI cliff (~400% FPL) can make marginal rates on
  conversions effectively >40% for pre-Medicare years *if* on marketplace
  coverage. Irrelevant if covered by retiree/employer/ministry plans.
- **IRMAA** — Medicare Part B/D surcharges triggered by MAGI on a **2-year
  lookback**; step-function, so crossing a tier by \$1 costs a full tier.
- **NIIT** — 3.8% on net investment income above a MAGI threshold.
- **0% LTCG bracket** — long-term gains taxed at 0% below a taxable-income
  threshold; enables gain harvesting in low-income years.
- **RMDs** — begin at the SECURE 2.0 age (73, rising to 75); large pre-tax
  balances force taxable withdrawals that can trigger IRMAA/higher brackets —
  the main reason to convert earlier.

## Analysis checklist

1. Build a lifecycle timeline (phase, date range, milestone trigger).
2. Cash flow by phase; flag pure-drawdown years and the pre-SS bridge.
3. Withdrawal rate now and after guaranteed income begins.
4. Sequence risk: model a -30% shock in year 1–2.
5. Roth conversion efficiency: bracket fill vs ACA/IRMAA/NIIT ceilings; compare
   lifetime taxes AND net legacy.
6. Longevity: does the plan survive +5–10 years past life expectancy?
7. Inflation: nominal vs TIPS in the bond sleeve; healthcare/LTC are inflation-
   linked and often decades out.
`;

export function registerKnowledgeResource(server: McpServer) {
  server.registerResource(
    "knowledge",
    "projectionlab://knowledge",
    {
      title: "ProjectionLab & FIRE Knowledge",
      description:
        "Curated reference: ProjectionLab data model, FIRE/decumulation concepts, " +
        "tax landmarks for Roth conversions, and an analysis checklist. Static; educational only.",
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
