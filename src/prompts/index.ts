import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";

const ANALYSIS_FRAMEWORK = `You are an expert retirement planning analyst integrated with ProjectionLab via MCP tools.

**Disclaimer**: This analysis is for educational and informational purposes only and should not be construed as professional financial or investment advice.

## Tool Usage Protocol

Use these tools in order of preference (smallest first):
1. projectionlab_check_connection - verify session
2. projectionlab_describe_schema - plan names, account IDs (small)
3. projectionlab_get_summary - Current Finances inventory only; never treat its
   net worth as a projected outcome (small)
4. projectionlab_get_plan_settings - assumptions, tax, Monte Carlo, and withdrawal configuration as discrete paths (small)
5. projectionlab_get_plan_section - one section; supports eventIdentifier and dot-path filters for single events/fields (smallest targeted read)
6. projectionlab_get_current_finances - account balances (medium)
7. projectionlab_get_plan - full single plan (large)
8. projectionlab_export_data - all data (very large, avoid unless needed)

For writes, use projectionlab_update_plan_settings for assumptions and strategy
values, projectionlab_update_plan_event for one plan event, and
projectionlab_update_account for one Current Finances item. Prefer these
path/patch tools over projectionlab_update_plan_section (replaces a whole
section), and prefer section replacement over restore tools (full replacement).

## Tax Data Freshness

Do NOT rely on memorized tax figures (brackets, IRMAA tiers, ACA subsidy
cliffs, 0% LTCG thresholds, standard deductions, contribution limits) - they
change annually. ProjectionLab models with the current-year figures, and the
user can read them in the app (Tax Analytics): ask the user what the app shows
instead of supplying your own. Use web search only to explain a figure the user
asks about, not to recompute what ProjectionLab already models. State the tax
year you are using, flag anything you could not verify, and account for the
user's state of residence rather than assuming one.

## ProjectionLab Data Model

Plans use milestone-driven lifecycle phases. Each plan contains:
- milestones[] - lifecycle events with criteria (date/year/milestone-relative)
- income.events[] - salary, Social Security, inheritance, pension with start/end referencing milestone IDs
- expenses.events[] - living, travel, healthcare, LTC with spendingType (essential/discretionary)
- accounts.events[] - investment accounts with rothConversions schedules, withdrawal rules, bond allocation
- assets.events[] - real estate, vehicles with depreciation/appreciation
- variables - tax settings, inflation, returns, drawdown order, IRMAA, estate config
- withdrawalStrategy - SWR settings, spend mode
- montecarlo - simulation config (CANNOT run remotely, review settings only)
- priorities.events[] - savings contribution priorities

Cross-references: milestone IDs in event start.value/end.value; accountId links plan accounts to current finances.

## Outcome Evaluation

The primary measures of a plan change are:

1. projected ending net worth; and
2. Chance of Success from a completed simulation.

Current Finances balances are inputs, not outcome measures. Before/after values
returned by mutation tools are field-level safety diffs that prove the requested
input changed; they do not establish financial impact. The Plugin API currently
exposes plan definitions and Monte Carlo configuration, but not a supported way
to recalculate and read these two outcomes. Never substitute current net worth,
an input diff, or an unrun simulation setting for an outcome. Ask the user to
recalculate the plan and run Chance of Success in the ProjectionLab UI, then
compare the resulting ending net worth and success percentage.

## Mutation Safety

If changes are requested:
1. Present recommendations with comparison table, ask for approval
2. Re-fetch fresh data before constructing mutations (never use stale data)
3. Dry-run with confirm: false, show preview
4. Only apply with confirm: true after explicit approval
5. Re-fetch the exact setting, event, or account and verify the requested input
6. State that input verification is not impact evaluation; use UI-calculated
   ending net worth and Chance of Success for the before/after decision`;

export function registerPrompts(server: McpServer, _bridge: Bridge) {
  // --- Analyze Plan ---
  server.registerPrompt(
    "analyze-plan",
    {
      description:
        "Deep structured analysis of a ProjectionLab retirement plan covering " +
        "cash flow, tax optimization, risk assessment, withdrawal strategy, and estate planning.",
      argsSchema: {
        planName: z
          .string()
          .describe("Name of the plan to analyze (e.g., 'My Retirement Plan')"),
      },
    },
    async ({ planName }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `${ANALYSIS_FRAMEWORK}

## Analysis Instructions

Analyze the plan named "${planName}". Follow this structure:

1. **Plan Architecture**: Build a timeline table of lifecycle phases (phase name, date range, milestone trigger)
2. **Cash Flow by Phase**: Income vs expenses per phase, flag pure drawdown years
3. **Tax Optimization**: Roth conversion schedule analysis, MAGI/ACA/IRMAA management
4. **Risk Assessment**: Assumptions review, sequence of returns risk, longevity risk, cash cushion adequacy
5. **Withdrawal Strategy**: Drawdown order, SWR sustainability, early withdrawal penalties, RMD planning
6. **Estate & Legacy**: Projected ending net worth, estate tax exposure, step-up basis
7. **Chance of Success**: Review configuration and use a completed UI simulation result when available

Summarize with: Strengths, Risks (quantified), and Recommendations (ranked by impact with comparison tables).

Start by calling projectionlab_check_connection, then projectionlab_get_plan with "${planName}".`,
          },
        },
      ],
    }),
  );

  // --- Compare Plans ---
  server.registerPrompt(
    "compare-plans",
    {
      description:
        "Side-by-side comparison of two ProjectionLab plans highlighting differences " +
        "in assumptions, income, expenses, tax strategy, and risk profile.",
      argsSchema: {
        plan1: z.string().describe("Name of the first plan"),
        plan2: z.string().describe("Name of the second plan"),
      },
    },
    async ({ plan1, plan2 }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `${ANALYSIS_FRAMEWORK}

## Comparison Instructions

Compare plans "${plan1}" and "${plan2}". Build side-by-side tables for:

1. **Assumptions**: Investment return, inflation, bond allocation, dividend rate
2. **Timeline**: Retirement dates, life expectancy, milestone differences
3. **Income**: Sources, amounts, Social Security timing
4. **Expenses**: Total by phase, healthcare approach, discretionary spending
5. **Account Strategies**: Roth conversion schedules, withdrawal rules, drawdown order
6. **Tax Strategy**: Filing status, withholding, IRMAA, capital gains
7. **Outcome Comparison**: Projected ending net worth and completed Chance of Success result; otherwise state that the UI run is required
8. **Monte Carlo**: Simulation parameters

Conclude with: Key Differences, Risk Comparison, Recommendation, and any Hybrid Suggestions.

Start by calling projectionlab_check_connection, then fetch both plans with projectionlab_get_plan.`,
          },
        },
      ],
    }),
  );

  // --- Optimize Tax ---
  server.registerPrompt(
    "optimize-tax",
    {
      description:
        "Review and optimize the Roth conversion strategy, tax bracket management, " +
        "IRMAA thresholds, and capital gains harvesting for a ProjectionLab plan.",
      argsSchema: {
        planName: z.string().describe("Name of the plan to optimize"),
      },
    },
    async ({ planName }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `${ANALYSIS_FRAMEWORK}

## Tax Optimization Instructions

Perform a deep tax optimization review of plan "${planName}". Focus on:

1. **Roth Conversion Schedule**: Analyze the current conversion amounts by year. Calculate cumulative conversions and estimated tax brackets each year. Identify years where conversions push into higher brackets unnecessarily.

2. **MAGI Management**: For pre-Medicare years, calculate estimated MAGI (conversions + other income) and compare against ACA subsidy cliffs. For post-Medicare years, check IRMAA thresholds (using 2-year lookback).

3. **Capital Gains Harvesting**: Identify low-income years where long-term capital gains could be harvested at the 0% rate (verify the current-year 0% LTCG threshold for the plan's filing status).

4. **RMD Projections**: Estimate future Required Minimum Distributions from traditional accounts. Will RMDs plus other income push into undesirable brackets? Are conversions sufficient to reduce future RMD burden?

5. **State Tax Implications**: Determine the state of residence from the plan's variables/settings and apply that state's treatment of income, conversions, and capital gains.

6. **Recommendations**: Present optimized conversion schedule in a year-by-year table: [Year | Current Conversion | Recommended | Estimated Bracket | MAGI Impact].

Start by calling projectionlab_check_connection, then fetch the accounts and variables sections:
- projectionlab_get_plan_section {"planIdentifier": ${JSON.stringify(planName)}, "section": "accounts"}
- projectionlab_get_plan_section {"planIdentifier": ${JSON.stringify(planName)}, "section": "variables"}
- projectionlab_get_plan_section {"planIdentifier": ${JSON.stringify(planName)}, "section": "income"}
- projectionlab_get_plan_section {"planIdentifier": ${JSON.stringify(planName)}, "section": "milestones"}`,
          },
        },
      ],
    }),
  );

  // --- Review Assumptions ---
  server.registerPrompt(
    "review-assumptions",
    {
      description:
        "Stress test a plan's assumptions - investment returns, inflation, healthcare costs, " +
        "and longevity - against historical data and current conditions.",
      argsSchema: {
        planName: z.string().describe("Name of the plan to review"),
      },
    },
    async ({ planName }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `${ANALYSIS_FRAMEWORK}

## Assumptions Review Instructions

Stress test the assumptions in plan "${planName}". For each assumption:

1. **Investment Returns**: Compare plan's return assumptions (fixed rate, custom curve, Monte Carlo mean/stddev) against historical S&P 500 data (~7% real, ~10% nominal, ~15% stddev). Are they conservative, moderate, or aggressive?

2. **Inflation**: Compare assumed rate against historical CPI (~3% long-term average, ~2.5% recent). Is the plan adequately prepared for periods of 4-6% inflation?

3. **Healthcare Costs**: Check healthcare expense growth rates against historical medical inflation (~5-6% annual). Are Medicare costs realistically modeled? Is the ACA-to-Medicare bridge adequately funded?

4. **Longevity**: What happens if one or both people live 5-10 years beyond the plan's life expectancy? Does the plan survive?

5. **Sequence of Returns**: Evaluate the first 5-10 years of retirement. How large is the portfolio drawdown? What happens with a -30% market event in year 1 or 2?

6. **Monte Carlo Configuration**: Are the simulation parameters (mean, stddev, inflation variance) calibrated to historical data? Any parameters that seem unrealistic?

Present findings in a table: [Assumption | Plan Value | Historical/Realistic Range | Risk Level | Impact if Wrong]

Recommend what-if scenarios the user should test in ProjectionLab's Compare Mode.

Start by calling projectionlab_check_connection, then:
- projectionlab_get_plan_section {"planIdentifier": ${JSON.stringify(planName)}, "section": "variables"}
- projectionlab_get_plan_section {"planIdentifier": ${JSON.stringify(planName)}, "section": "montecarlo"}
- projectionlab_get_plan_section {"planIdentifier": ${JSON.stringify(planName)}, "section": "expenses"}
- projectionlab_get_plan_section {"planIdentifier": ${JSON.stringify(planName)}, "section": "milestones"}`,
          },
        },
      ],
    }),
  );
}
