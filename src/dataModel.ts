import { ProjectionLabError } from "./errors.js";

/**
 * Verified field knowledge for the values this server reads and writes.
 * Single source for the `projectionlab://data-model` resource, the
 * `listPaths` annotations, and the enum refusals in the shared write path.
 *
 * Entries carry evidence:
 * - "observed": a value was set through the UI and the stored value was
 *   read back (or matched field-for-field against a known plan).
 * - "ui-label": the control was seen in the UI but not confirmed by a
 *   stored-value test.
 * - "export-shape": the field and its value type appear in a ProjectionLab 5
 *   export; its meaning is not yet confirmed by a stored-value test.
 * Only fields confirmed against ProjectionLab 5.0.0, or plan settings
 * confirmed against ProjectionLab 4.6.0 and carried as export-shape, are
 * listed; fields known from names alone are left out entirely.
 */
export const DATA_MODEL_V5_PROJECTIONLAB_VERSION = "5.0.0";

export type DataModelEvidence = "observed" | "ui-label" | "export-shape";

export interface DataModelField {
  description: string;
  /** Scale for numeric fields, e.g. "percentage points" or "decimal fraction". */
  units?: string;
  /** Complete set of values an enum field accepts. */
  allowedValues?: readonly string[];
  /** Which other field must be set for this field to matter. */
  enabledBy?: string;
  note?: string;
  /** Label of the control that shows this field in ProjectionLab 5.0.0. */
  uiLabel?: string;
  /** Where that control is in ProjectionLab 5.0.0, including the mode or
   * choice that must be selected for it to appear. */
  uiLocation?: string;
  evidence: DataModelEvidence;
}

export interface DataModelGroup {
  /** Prefix the paths are listed and written under: a settings section,
   * an event section, or a Current Finances collection. */
  scope: string;
  title: string;
  fields: Record<string, DataModelField>;
}

const PCT = "percentage points";
const FRAC = "decimal fraction";
const DOLLARS = "dollars";
const YEARS = "years";

// Plan settings groups as confirmed against ProjectionLab 4.6.0. ProjectionLab
// 5 stores the same fields; DATA_MODEL_V5_GROUPS carries them as
// export-shape until each is confirmed there by a stored-value test.
const PLAN_SETTINGS_GROUPS: readonly DataModelGroup[] = [
  {
    scope: "variables",
    title: "Plan settings: variables (assumptions, tax, estate, flows)",
    fields: {
      assumptionsMode: {
        description:
          "Return and inflation modeling mode: static baseline rates, a backtested historical sequence, or custom piecewise curves.",
        allowedValues: ["fixed", "historical", "custom"],
        evidence: "observed",
        note: '"historical" enables startYear and loopYear; "custom" enables the *Custom curve objects.',
      },
      inflation: {
        description:
          "Annual baseline inflation rate applied to living expenses and cost escalations.",
        units: PCT,
        evidence: "observed",
        note: "Write 3.25 for 3.25%, not 0.0325.",
      },
      investmentReturn: {
        description: "Expected annual capital appreciation of stock equity investments.",
        units: PCT,
        evidence: "observed",
        note: "Write 5 for 5%.",
      },
      dividendRate: {
        description: "Annual dividend yield on stock equity investments.",
        units: PCT,
        evidence: "observed",
      },
      bondInvestmentReturn: {
        description: "Capital appreciation rate of fixed-income holdings.",
        units: PCT,
        evidence: "observed",
      },
      bondDividendRate: {
        description: "Annual coupon or interest yield on bond holdings.",
        units: PCT,
        evidence: "observed",
      },
      benefitColaModifier: {
        description:
          "Adjustment to the cost-of-living raise applied to Social Security benefits relative to baseline inflation.",
        units: PCT,
        evidence: "ui-label",
        note: "0 applies baseline inflation unchanged.",
      },
      startYear: {
        description: "Historical calendar year that anchors the projection start.",
        units: "calendar year",
        enabledBy: 'assumptionsMode "historical"',
        evidence: "ui-label",
      },
      loopYear: {
        description:
          "Historical year to jump back to when the projection outlasts the historical data range.",
        units: "calendar year",
        enabledBy: 'assumptionsMode "historical"',
        evidence: "ui-label",
      },
      "dividendSettings.reinvestment.enabled": {
        description:
          "When true, stock dividends are reinvested into the originating account instead of paid out.",
        evidence: "ui-label",
      },
      "dividendSettings.composition.qualifiedPercent": {
        description:
          "Share of stock dividends taxed at preferential capital gains rates; the remainder is ordinary income.",
        units: PCT,
        evidence: "ui-label",
      },
      "dividendSettings.composition.country": {
        description: "Tax jurisdiction country as an ISO country string.",
        evidence: "ui-label",
      },
      "bondSettings.allocationType": {
        description: "How the target portfolio bond allocation is modeled.",
        allowedValues: ["none", "target", "custom"],
        evidence: "observed",
      },
      "bondSettings.allocation": {
        description:
          "Timeline coordinate points defining the target bond allocation percentage over time.",
        evidence: "ui-label",
        note: "Array of { x, y } points where y is a percentage (0-100).",
      },
      "bondSettings.location.type": {
        description: "How target bonds are placed across individual accounts.",
        allowedValues: ["evenly", "account-order"],
        evidence: "observed",
        note: '"account-order" uses bondSettings.location.accountOrder.',
      },
      "bondSettings.location.accountOrder": {
        description:
          "Ordered account UUIDs giving the priority in which accounts are filled with bonds.",
        enabledBy: 'bondSettings.location.type "account-order"',
        evidence: "observed",
      },
      "bondSettings.composition.municipalPercent": {
        description:
          "Share of bond income that is federally tax-exempt municipal income; the remainder is fully taxable.",
        units: PCT,
        evidence: "ui-label",
      },
      "bondSettings.composition.treasuryPercent": {
        description:
          "Share of bond income that is state tax-exempt treasury income.",
        units: PCT,
        evidence: "ui-label",
      },
      estimateTaxes: {
        description: "Enables or disables algorithmic tax estimation for the plan.",
        evidence: "ui-label",
      },
      filingStatus: {
        description: "Tax filing status used by tax estimation.",
        allowedValues: ["single", "joint", "head-of-household", "separate"],
        evidence: "ui-label",
      },
      "withholding.taxDeferred": {
        description:
          "Rate withheld at tax-deferred withdrawal to model interim cash flow before annual tax reconciliation.",
        units: PCT,
        evidence: "observed",
      },
      "withholding.taxable": {
        description: "Rate withheld at taxable withdrawal.",
        units: PCT,
        evidence: "observed",
      },
      "withholding.conversions": {
        description: "Rate withheld at Roth conversions.",
        units: PCT,
        evidence: "observed",
      },
      bbbSaltReversion: {
        description:
          "When true, assumes the increased SALT deduction cap expires on its statutory schedule.",
        evidence: "observed",
      },
      bbbSeniorReversion: {
        description:
          "When true, assumes the senior bonus deduction expires on its statutory schedule.",
        evidence: "ui-label",
      },
      incomeTaxModifier: {
        description: "Shifts statutory ordinary income bracket rates up or down across the board.",
        units: PCT,
        evidence: "ui-label",
      },
      capGainsModifier: {
        description: "Shifts statutory capital gains rates up or down across the board.",
        units: PCT,
        evidence: "ui-label",
      },
      "taxStrategy.type": {
        description: "Tax strategy mode: fill a target bracket, optimize, or compare.",
        allowedValues: ["bracket", "optimize", "compare"],
        evidence: "ui-label",
      },
      "taxStrategy.bracketRate": {
        description:
          "Marginal ordinary income bracket to fill with strategic Roth conversions.",
        units: FRAC,
        evidence: "observed",
        note: "Write 0.22 for 22%, not 22. Typical choices: 0.1, 0.12, 0.22, 0.24, 0.32, 0.35.",
      },
      "taxStrategy.capGainsBracketRate": {
        description: "Capital gains bracket to stay within.",
        units: FRAC,
        evidence: "observed",
        note: "Write 0.15 for the 15% bracket or 0 for the tax-free threshold.",
      },
      "taxStrategy.niitCeiling": {
        description:
          "When true, caps investment income below the net investment income tax threshold.",
        evidence: "observed",
      },
      "taxStrategy.irmaaCeiling": {
        description: "When true, caps MAGI below Medicare premium surcharge cliffs.",
        evidence: "observed",
      },
      "taxStrategy.irmaaCliffIndex": {
        description: "Which Medicare premium surcharge cliff to stay below.",
        units: "count",
        enabledBy: "taxStrategy.irmaaCeiling",
        note: "0 is the first cliff (no surcharges); higher indexes are later cliffs.",
        evidence: "observed",
      },
      "taxStrategy.acaCeiling": {
        description: "When true, caps MAGI to protect ACA premium tax credits.",
        evidence: "observed",
      },
      "taxStrategy.federalPovertyLevelMultiple": {
        description: "Federal poverty level multiplier the ACA subsidy cap targets.",
        units: "count",
        enabledBy: "taxStrategy.acaCeiling",
        note: "An integer multiplier: 4 means 400% of the federal poverty level.",
        evidence: "observed",
      },
      "rothConversionStrategy.enabled": {
        description: "Enables strategic Roth conversions.",
        evidence: "ui-label",
      },
      "gainHarvestingStrategy.enabled": {
        description: "Enables systematic harvesting within the zero capital gains bracket.",
        evidence: "ui-label",
      },
      "drawdownBlendingStrategy.enabled": {
        description: "Enables withdrawal shielding and blended account decumulation.",
        evidence: "ui-label",
      },
      drawdownOrder: {
        description:
          "Ordered account categories used to cover cash deficits, liquidated front to back.",
        evidence: "ui-label",
        note: 'Elements include "excess-cash", "taxable", "hsa-medical", "ira/401k", "free-roth-ira-contributions", "roth-ira", "non-qualified-ira/401k", "non-qualified-roth", "non-qualified-hsa", "all-cash".',
      },
      "estate.taxDeferredRate": {
        description: "Ordinary income rate heirs pay on inherited pre-tax accounts.",
        units: PCT,
        evidence: "ui-label",
      },
      "estate.taxableGainsRate": {
        description:
          "Capital gains rate on taxable accounts when no basis step-up is assumed.",
        units: PCT,
        enabledBy: 'estate.stepUpBasis false',
        evidence: "ui-label",
      },
      "estate.stepUpBasis": {
        description:
          "When true, taxable holdings are assumed to receive a full basis step-up at death.",
        evidence: "ui-label",
      },
      "estate.assetLiquidationFee": {
        description: "Transaction, legal, and broker fees on liquidating real property.",
        units: PCT,
        evidence: "ui-label",
      },
      "estate.charityRate": {
        description: "Share of the gross estate bequeathed to charity.",
        units: PCT,
        evidence: "ui-label",
      },
      "estate.adminRate": {
        description: "Probate, legal, and executor settlement costs.",
        units: PCT,
        evidence: "ui-label",
      },
      cashFlowDefault: {
        description: "What happens to leftover annual cash after all priorities are funded.",
        allowedValues: ["save", "spend"],
        evidence: "observed",
        note: '"save" adds it to cash holdings; "spend" treats it as discretionary spending.',
      },
    },
  },
  {
    scope: "montecarlo",
    title: "Plan settings: montecarlo (Chance of Success simulation)",
    fields: {
      trials: {
        description: "Number of simulated trial paths to run.",
        units: "count",
        evidence: "observed",
      },
      iterations: {
        description: "Concurrent simulation worker tasks.",
        units: "count",
        evidence: "ui-label",
      },
      sampling: {
        description: "How historical market data is sampled for each trial.",
        allowedValues: [
          "random-start-random-restart",
          "block-bootstrap",
          "random-year",
        ],
        evidence: "observed",
        note: '"block-bootstrap" samples blocks of blockSize consecutive years.',
      },
      blockSize: {
        description: "Length of the consecutive-year blocks sampled per trial.",
        units: YEARS,
        enabledBy: 'sampling "block-bootstrap"',
        evidence: "ui-label",
      },
      mode: {
        description: "Data sources feeding the simulation.",
        allowedValues: ["backtest", "custom", "blended"],
        evidence: "ui-label",
      },
      trialMetric: {
        description: "Metric that decides success or failure of each trial.",
        evidence: "ui-label",
        note: 'Typically "netWorth".',
      },
      statsMetric: {
        description: "Metric plotted as the primary percentile-band distribution.",
        evidence: "ui-label",
        note: 'Typically "liquidNetWorth".',
      },
      metrics: {
        description: "Metrics monitored during the simulation.",
        evidence: "ui-label",
        note: 'Array of strings such as "netWorth", "liquidNetWorth", "expenses", "taxes", "effectiveTaxRate", "savingsRate", "wr".',
      },
      investmentReturn: {
        description: "Source of the stock growth rate distribution.",
        allowedValues: ["custom", "backtest"],
        evidence: "observed",
      },
      investmentReturnMean: {
        description: "Mean annual stock growth used when sampling is custom.",
        units: PCT,
        enabledBy: 'investmentReturn "custom"',
        evidence: "observed",
      },
      investmentReturnStdDev: {
        description: "Standard deviation of annual stock growth.",
        units: PCT,
        enabledBy: 'investmentReturn "custom"',
        evidence: "observed",
      },
      dividendRate: {
        description: "Source of the stock dividend distribution.",
        allowedValues: ["custom", "backtest"],
        evidence: "observed",
      },
      dividendRateMean: {
        description: "Mean annual dividend yield used when sampling is custom.",
        units: PCT,
        enabledBy: 'dividendRate "custom"',
        evidence: "observed",
      },
      dividendRateStdDev: {
        description: "Standard deviation of the annual dividend yield.",
        units: PCT,
        enabledBy: 'dividendRate "custom"',
        evidence: "observed",
      },
      inflation: {
        description: "Source of the inflation distribution.",
        allowedValues: ["custom", "backtest"],
        evidence: "observed",
      },
      inflationMean: {
        description: "Mean annual inflation used when sampling is custom.",
        units: PCT,
        enabledBy: 'inflation "custom"',
        evidence: "observed",
      },
      inflationStdDev: {
        description: "Standard deviation of annual inflation.",
        units: PCT,
        enabledBy: 'inflation "custom"',
        evidence: "observed",
      },
      bondReturn: {
        description: "Source of the bond return distribution.",
        allowedValues: ["custom", "backtest"],
        evidence: "observed",
      },
      bondReturnMean: {
        description: "Mean annual bond return used when sampling is custom.",
        units: PCT,
        enabledBy: 'bondReturn "custom"',
        evidence: "observed",
      },
      bondReturnStdDev: {
        description: "Standard deviation of the annual bond return.",
        units: PCT,
        enabledBy: 'bondReturn "custom"',
        evidence: "observed",
      },
      cryptoReturn: {
        description: "Source of the crypto return distribution.",
        allowedValues: ["custom", "backtest"],
        evidence: "observed",
      },
      cryptoReturnMean: {
        description: "Mean annual crypto return used when sampling is custom.",
        units: PCT,
        enabledBy: 'cryptoReturn "custom"',
        evidence: "observed",
      },
      cryptoReturnStdDev: {
        description: "Standard deviation of the annual crypto return.",
        units: PCT,
        enabledBy: 'cryptoReturn "custom"',
        evidence: "observed",
      },
    },
  },
  {
    scope: "withdrawalStrategy",
    title: "Plan settings: withdrawalStrategy (textbook withdrawals)",
    fields: {
      enabled: {
        description:
          "When true, overrides standard plan discretionary events and applies the active withdrawal rule from start onward.",
        evidence: "observed",
      },
      strategy: {
        description: "Active withdrawal rule.",
        allowedValues: [
          "initial-%",
          "fixed-%",
          "fixed-amount",
          "kitces-ratchet",
          "vpw",
          "1/N",
          "clyatt-95%",
          "guyton-klinger",
        ],
        evidence: "observed",
        note: 'The parameter block for the active rule lives under a key of the same name, e.g. "fixed-%.amount".',
      },
      "start.type": {
        description: "Kind of the begin-strategy reference.",
        allowedValues: ["milestone"],
        evidence: "ui-label",
      },
      "start.value": {
        description: "Milestone ID at which the strategy begins.",
        evidence: "ui-label",
      },
      "start.modifier": {
        description: "Offset applied to the begin-strategy milestone.",
        evidence: "ui-label",
      },
      income: {
        description: "How planned income interacts with the withdrawal amount.",
        allowedValues: ["decrease-drawdown", "add-to-drawdown", "ignore"],
        evidence: "ui-label",
      },
      spendMode: {
        description:
          'Whether the strategy targets net withdrawals ("withdraw", spend is reduced when taxes are incurred) or gross annual spend ("spend", withdrawals are grossed up to cover taxes).',
        allowedValues: ["withdraw", "spend"],
        evidence: "ui-label",
      },
      "initial-%.amount": {
        description: "Initial withdrawal rate of the starting portfolio.",
        units: PCT,
        evidence: "ui-label",
      },
      "initial-%.minType": {
        description: "Basis of the minimum drawdown bound.",
        allowedValues: ["today$", "future$", "%"],
        evidence: "ui-label",
      },
      "initial-%.maxType": {
        description: "Basis of the maximum drawdown bound.",
        allowedValues: ["today$", "future$", "%"],
        evidence: "ui-label",
      },
      "fixed-%.amount": {
        description: "Withdrawal rate of the current portfolio balance each year.",
        units: PCT,
        evidence: "ui-label",
      },
      "fixed-%.minType": {
        description: "Basis of the minimum drawdown bound.",
        allowedValues: ["today$", "future$", "%"],
        evidence: "ui-label",
      },
      "fixed-%.maxType": {
        description: "Basis of the maximum drawdown bound.",
        allowedValues: ["today$", "future$", "%"],
        evidence: "ui-label",
      },
      "fixed-amount.amount": {
        description: "Fixed dollar amount withdrawn each year.",
        units: DOLLARS,
        evidence: "ui-label",
      },
      "fixed-amount.amountType": {
        description: "Currency basis of the fixed withdrawal amount.",
        allowedValues: ["today$", "future$"],
        evidence: "ui-label",
      },
      "fixed-amount.adjust": {
        description: "When true, adjusts the fixed amount for inflation.",
        evidence: "ui-label",
      },
      "kitces-ratchet.amount": {
        description: "Initial withdrawal rate of the current portfolio.",
        units: PCT,
        evidence: "ui-label",
      },
      "kitces-ratchet.threshold": {
        description: "Portfolio change that triggers a ratchet adjustment.",
        units: PCT,
        evidence: "ui-label",
      },
      "kitces-ratchet.ratchet": {
        description: "Adjustment applied to the withdrawal when a ratchet fires.",
        units: PCT,
        evidence: "ui-label",
      },
      "kitces-ratchet.cooldown": {
        description: "Years before the ratchet may adjust again.",
        units: YEARS,
        evidence: "ui-label",
      },
      "clyatt-95%.amount": {
        description: "Initial withdrawal rate of the current portfolio.",
        units: PCT,
        evidence: "ui-label",
      },
      "clyatt-95%.percentOfPrevious": {
        description: "Share of the previous year's withdrawal taken when the portfolio fell.",
        units: PCT,
        evidence: "ui-label",
        note: "95 implements the 95% rule.",
      },
      "guyton-klinger.amount": {
        description: "Initial withdrawal rate of the starting portfolio.",
        units: PCT,
        evidence: "ui-label",
      },
      "guyton-klinger.guardrail": {
        description: "Deviation from the initial rate that trips a guardrail.",
        units: PCT,
        evidence: "ui-label",
      },
      "guyton-klinger.adjustment": {
        description: "Adjustment applied to the withdrawal when a guardrail trips.",
        units: PCT,
        evidence: "ui-label",
      },
    },
  },
];

function asExportShapeGroup(group: DataModelGroup): DataModelGroup {
  const fields: Record<string, DataModelField> = {};
  for (const [pattern, field] of Object.entries(group.fields)) {
    fields[pattern] = { ...field, evidence: "export-shape" };
  }
  return { ...group, fields };
}

// Year alignment in ProjectionLab 5. Every choice was set in a plan's Override
// Year Alignment control and read back; Account Settings offers the same
// choices, and "calendar" and "custom" were read back from it as well.
const ALIGNMENT_TYPES = ["calendar", "rolling", "au-tax", "uk-tax", "custom"] as const;
const ALIGNMENT_NOTE =
  '"calendar" runs January to December; "rolling" stores no date and counts plan years from the current month; "au-tax" stores date "2000-07-01" and "uk-tax" stores "2000-04-01"; "custom" stores the chosen starting month as "2000-MM-01". The plan ends on the last day of the plan year that holds the household\'s latest life expectancy, so changing the alignment can add or remove a plan year.';
const ALIGNMENT_DATE_DESCRIPTION =
  'Month each plan year starts, as "2000-MM-01"; only the month is meaningful.';

const VARIABLES_V5_BASE = asExportShapeGroup(
  PLAN_SETTINGS_GROUPS.find((g) => g.scope === "variables")!,
);
const VARIABLES_V5_GROUP: DataModelGroup = {
  ...VARIABLES_V5_BASE,
  fields: {
    ...VARIABLES_V5_BASE.fields,
    "bondSettings.allocation": {
      ...VARIABLES_V5_BASE.fields["bondSettings.allocation"],
      evidence: "observed",
      note:
        "Array of { x, y } points: x is the plan year (1 is the current plan year) and y is a percentage (0-100). " +
        "ProjectionLab keeps the last point on the plan's final year. When a change of year alignment shortens the plan, the app moves that point to the new final year; when the plan lengthens again, it adds a point at the new final year and keeps the moved one.",
    },
    "alignment.type": {
      description:
        "This plan's own year alignment. null or absent means the plan follows the account's settings plan.alignment.",
      allowedValues: ALIGNMENT_TYPES,
      evidence: "observed",
      note: ALIGNMENT_NOTE,
    },
    "alignment.date": {
      description: ALIGNMENT_DATE_DESCRIPTION,
      enabledBy: 'alignment.type "custom", "au-tax" or "uk-tax"',
      evidence: "observed",
    },
  },
};
const MONTECARLO_V5_GROUP = asExportShapeGroup(
  PLAN_SETTINGS_GROUPS.find((g) => g.scope === "montecarlo")!,
);
const WITHDRAWAL_STRATEGY_V5_GROUP = asExportShapeGroup(
  PLAN_SETTINGS_GROUPS.find((g) => g.scope === "withdrawalStrategy")!,
);

export const DATA_MODEL_V5_GROUPS: readonly DataModelGroup[] = [
  {
    scope: "envelope",
    title: "Document envelope",
    fields: {
      schema: {
        description: "Root envelope schema version (1 in ProjectionLab 5 exports).",
        units: "count",
        evidence: "export-shape",
      },
      exportedAt: {
        description: "Timestamp in milliseconds when the export was generated.",
        units: "milliseconds",
        evidence: "export-shape",
      },
      documents: {
        description: "Container holding currentFinances, plans, settings, and accountHistory documents.",
        evidence: "export-shape",
      },
    },
  },
  {
    scope: "currentFinances",
    title: "Current Finances document",
    fields: {
      schema: {
        description: "Current Finances document schema version (5 in ProjectionLab 5).",
        units: "count",
        evidence: "export-shape",
      },
      lastUpdated: {
        description: "Timestamp in milliseconds of the last modification.",
        units: "milliseconds",
        evidence: "export-shape",
      },
      "location.country": {
        description: "Tax residence country code of the household.",
        evidence: "export-shape",
      },
      "location.state": {
        description: "State or province code of the household.",
        evidence: "export-shape",
      },
      "household.partnerStatus": {
        description: "Household partnership status.",
        evidence: "export-shape",
      },
      "household.people.me.id": {
        description: "Identifier of the primary household person.",
        evidence: "export-shape",
      },
      "household.people.me.name": {
        description: "Display label of the primary household person.",
        evidence: "export-shape",
      },
      "household.people.me.birthYear": {
        description: "Birth year of the primary household person.",
        units: "count",
        evidence: "export-shape",
      },
      "household.people.me.birthMonth": {
        description: "Birth month index of the primary household person.",
        units: "count",
        evidence: "export-shape",
      },
      "household.people.me.lifeExpectancy": {
        description: "Target life expectancy age for modeling the primary household person.",
        units: "age",
        evidence: "export-shape",
      },
      "household.people.me.color": {
        description: "Display color code for the primary household person.",
        evidence: "export-shape",
      },
      "household.people.me.icon": {
        description: "Icon identifier for the primary household person.",
        evidence: "export-shape",
      },
      "household.people.me.character": {
        description: "Character avatar string for the primary household person.",
        evidence: "export-shape",
      },
      "household.people.spouse.id": {
        description: "Identifier of the spouse.",
        evidence: "export-shape",
      },
      "household.people.spouse.name": {
        description: "Display label of the spouse.",
        evidence: "export-shape",
      },
      "household.people.spouse.birthYear": {
        description: "Birth year of the spouse.",
        units: "count",
        evidence: "export-shape",
      },
      "household.people.spouse.birthMonth": {
        description: "Birth month index of the spouse.",
        units: "count",
        evidence: "export-shape",
      },
      "household.people.spouse.lifeExpectancy": {
        description: "Target life expectancy age for modeling the spouse.",
        units: "age",
        evidence: "export-shape",
      },
      "household.people.spouse.color": {
        description: "Display color code for the spouse.",
        evidence: "export-shape",
      },
      "household.people.spouse.icon": {
        description: "Icon identifier for the spouse.",
        evidence: "export-shape",
      },
      "household.people.spouse.character": {
        description: "Character avatar string for the spouse.",
        evidence: "export-shape",
      },
    },
  },
  {
    scope: "accounts",
    title: "Current Finances accounts and debts (keyed by account ID) and plan account events",
    fields: {
      id: {
        description: "Unique account identifier.",
        evidence: "export-shape",
      },
      name: {
        description: "Display label of the account.",
        evidence: "export-shape",
      },
      kind: {
        description: "Account category discriminator.",
        allowedValues: ["account", "debt", "real-asset"],
        evidence: "export-shape",
      },
      type: {
        description: "Account classification type.",
        allowedValues: ["taxable", "401k", "roth-401k", "ira", "savings", "land", "secured-loan"],
        evidence: "export-shape",
        note:
          'The Solo 401k, Roth Solo 401k, and SEP IRA account types store as type "401k" or "roth-401k" with subtype "solo", and type "ira" with subtype "sep".',
      },
      subtype: {
        description: "Sub-classification of the record.",
        evidence: "export-shape",
        note:
          'Real assets use values such as "lot"; a 401k or roth-401k account uses subtype "solo" for the Solo 401k and Roth Solo 401k types, and an ira account uses subtype "sep" for the SEP IRA type.',
      },
      owner: {
        description: "Which household member owns the account.",
        evidence: "observed",
        note:
          '"joint" is offered only for savings, taxable and crypto accounts, "spouse" only while the household has a partner, and household person identifiers plus "dependent" are valid for every non-inherited type. No allowedValues list is recorded because the identifiers are app-assigned.',
      },
      order: {
        description: "Display sort order index.",
        units: "count",
        evidence: "export-shape",
      },
      icon: {
        description: "Icon identifier displayed in the interface.",
        evidence: "export-shape",
      },
      archivedOn: {
        description: "ISO date string (YYYY-MM-DD) indicating when the account was archived.",
        evidence: "export-shape",
        note: "Present only on archived accounts.",
      },
      balance: {
        description: "Current balance in dollars for accounts and outstanding principal for debts.",
        units: DOLLARS,
        evidence: "export-shape",
        note: "Present on account and debt kinds.",
      },
      costBasis: {
        description: "Unadjusted tax cost basis in dollars for capital gains tracking on taxable accounts.",
        units: DOLLARS,
        evidence: "export-shape",
        note: "Present on account kind.",
      },
      value: {
        description: "Estimated fair market value in dollars for real assets.",
        units: DOLLARS,
        evidence: "export-shape",
        note: "Present on real-asset kind.",
      },
      purchasePrice: {
        description: "Historical acquisition cost in dollars for real assets.",
        units: DOLLARS,
        evidence: "export-shape",
        note: "Present on real-asset kind.",
      },
      securedByAssetId: {
        description: "Identifier of the real asset securing this debt.",
        evidence: "export-shape",
        note: "Present on debt kind when secured by an asset.",
      },
      accountId: {
        description: "Identifier of the associated Current Finances account on plan events.",
        evidence: "export-shape",
      },
      liquidity: {
        description:
          "Whether the balance counts toward liquid net worth: true, false, \"EWAge\" for once the account's qualified withdrawal age has passed, or a { date, type } object that starts or stops counting on a date.",
        enabledBy: "the account's Liquidity control",
        evidence: "observed",
        note:
          'Labelled Liquid, "Whether this counts toward your liquid assets." type "from" is the From Date control and "until" the Until Date control. An EWAge value counts the balance once the qualified withdrawal age has passed. The plan event key liquid does not exist: v5 normalization strips it.',
      },
      withdraw: {
        description:
          "When the account may be drawn down: true for any time, false for never, \"when-liquid\", \"after\" for a specific year given by withdrawAge, or \"EWAge\" for once the qualified withdrawal age has passed.",
        evidence: "observed",
        note:
          'Labelled Always, Never, When Liquid, Reach Specific Year and After Qualified Withdrawal Age. The control is offered only to account types that support it; When Liquid appears only while it is the stored value, and EWAge only for types with a qualified age. No allowedValues list is recorded: the list holds strings only, so listing "when-liquid", "after" and "EWAge" would read as ruling out the true and false values the field also takes.',
      },
      // Plan account events are listed and written under this scope by
      // section name, so their plan-side fields are carried from the
      // ProjectionLab 4 registry into this group as well.
      investmentGrowthType: {
        description:
          "Where the account's stock growth rate comes from.",
        allowedValues: ["plan", "fixed", "custom", "none"],
        evidence: "observed",
        note:
          'Labelled Stock Growth Rate ("plan", inherit from Plan Settings > Growth Rates), Fixed Rate ("fixed"), Advanced ("custom"), which stores the curve in investmentGrowthCustom as { type, data: [ { x, y } ] }, and None ("none", no investment growth).',
      },
      investmentGrowthRate: {
        description: "Custom annual growth rate for the account.",
        units: PCT,
        enabledBy: 'investmentGrowthType "fixed"',
        evidence: "observed",
      },
      dividendType: {
        description: "Where the account's dividend yield comes from.",
        allowedValues: ["plan", "fixed", "custom", "none"],
        evidence: "observed",
        note:
          'Labelled Stock Dividend Yield ("plan", inherit from Plan Settings > Growth Rates), Fixed Yield ("fixed", which uses dividendRate), Advanced ("custom"), which stores the curve in dividendRateCustom as { type, data: [ { x, y } ] }, and None ("none", no dividend yield).',
      },
      dividendRate: {
        description: "Custom annual dividend yield for the account.",
        units: PCT,
        enabledBy: 'dividendType "fixed"',
        evidence: "observed",
      },
      yearlyFee: {
        description: "Recurring account fee.",
        enabledBy: "the account's Fees control",
        evidence: "observed",
        note:
          'Labelled Yearly Fee, "Annual fee deducted from this account." Interpreted per yearlyFeeType: a percentage, a percentage of earnings, or a dollar amount.',
      },
      yearlyFeeType: {
        description: "How yearlyFee is read.",
        allowedValues: ["$", "today$", "%", "%-earnings"],
        enabledBy: "yearlyFee",
        evidence: "observed",
        note:
          'Rendered as a dollar amount a year ("$"), a dollar amount in today\'s currency ("today$"), a percentage of the balance ("%"), or a percentage of earnings a year ("%-earnings").',
      },
      withdrawAge: {
        description:
          "Timing reference after which the account becomes eligible for drawdown.",
        enabledBy: 'withdraw "after"',
        evidence: "observed",
        note:
          'The Reach Specific Year withdraw option, shown beside the Years control. Labelled "When withdrawals become available."',
      },
      rmdType: {
        description: "Statutory required minimum distribution regime.",
        allowedValues: [
          "us",
          "us-inherited",
          "stretch",
          "ten-year",
          "CA",
          "custom",
          "none",
        ],
        evidence: "observed",
        note:
          'Options carry applicableAccountTypes and inapplicableAccountTypes, so a given account offers the subset valid for its type and jurisdiction: "us" current US retirement rules, "us-inherited" inherited retirement rules, "stretch" pre-SECURE Act stretch IRA estimates for inherited ira and roth-ira accounts, "ten-year" a smoothed schedule divesting over ten years, "CA" Canadian RRIF rules, "custom" a schedule held in requiredDistributions, and "none".',
      },
      EWAge: {
        description: "Age used to determine qualified withdrawals.",
        units: "age",
        enabledBy: "account types that support a qualified withdrawal age",
        evidence: "observed",
        note:
          'Labelled Qualified Age, "Age used to determine qualified withdrawals." Offered by the account type rather than gated on hasEWPenalty, and the stored value also backs the liquidity and withdraw "EWAge" options.',
      },
      hasEWPenalty: {
        description:
          "Whether withdrawals before EWAge incur a penalty.",
        evidence: "observed",
        note:
          'Labelled Early Withdrawal Penalties, "Penalty for withdrawals before the qualified age." Switching it on reveals Penalty Rate and Freely Withdraw Contributions.',
      },
      EWPenaltyRate: {
        description: "Penalty applied to early withdrawals.",
        units: PCT,
        enabledBy: "hasEWPenalty",
        evidence: "observed",
        note:
          'Labelled Penalty Rate, "Penalty applied to early withdrawals." Commonly 10 for retirement accounts and 20 for an HSA.',
      },
    },
  },
  {
    scope: "assets",
    title: "Plan assets and real property",
    fields: {
      id: {
        description: "Unique event identifier.",
        evidence: "export-shape",
      },
      name: {
        description: "Display label of the asset.",
        evidence: "export-shape",
      },
      kind: {
        description: "Event category discriminator.",
        allowedValues: ["real-asset"],
        evidence: "export-shape",
      },
      assetId: {
        description: "Identifier of the corresponding Current Finances real asset.",
        evidence: "export-shape",
      },
      type: {
        description: "Asset classification type.",
        allowedValues: ["land"],
        evidence: "export-shape",
      },
      subtype: {
        description: "Sub-classification of the asset (such as lot).",
        evidence: "export-shape",
      },
      value: {
        description: "Market value in dollars.",
        units: DOLLARS,
        evidence: "export-shape",
      },
      valueType: {
        description: "Currency basis of the asset value.",
        evidence: "export-shape",
      },
      purchasePrice: {
        description: "Historical acquisition cost in dollars.",
        units: DOLLARS,
        evidence: "export-shape",
      },
      purchasePriceType: {
        description: "Currency basis of the purchase price.",
        evidence: "export-shape",
      },
      loans: {
        description: "Array of linked financing structures.",
        evidence: "export-shape",
      },
      // Entries carried from the ProjectionLab 4 registry for fields the
      // ProjectionLab 5 export shows.
      "start.type": {
        description:
          "Kind of the start reference: a calendar year, an age, a fixed date, a milestone, a life expectancy, or a keyword.",
        allowedValues: [
          "date",
          "year",
          "age",
          "milestone",
          "lifeExpectancy",
          "lastLifeExpectancy",
          "keyword",
        ],
        evidence: "export-shape",
      },
      paymentMethod: {
        description: "Whether the asset was bought outright or financed.",
        allowedValues: ["pay-in-full", "financed"],
        evidence: "export-shape",
      },
      downPayment: {
        description: "Cash down payment at acquisition.",
        units: DOLLARS,
        enabledBy: 'paymentMethod "financed"',
        evidence: "export-shape",
      },
      interestRate: {
        description: "Annual percentage rate of the asset's loan.",
        units: PCT,
        enabledBy: 'paymentMethod "financed"',
        evidence: "export-shape",
      },
      interestType: {
        description: "How interest accrues on the asset's loan.",
        allowedValues: ["simple", "compound"],
        evidence: "observed",
        note: 'Defaults to "simple"; "compound" is what reveals the Compounding control.',
      },
      compounding: {
        description: "Frequency at which loan interest compounds.",
        allowedValues: ["daily", "monthly"],
        enabledBy: 'interestType "compound"',
        evidence: "observed",
        note:
          'The Financing panel offers Daily and Monthly and defaults to monthly. It is a companion of Interest Type and stays hidden while Interest Type is "simple".',
      },
      monthlyPayment: {
        description: "Scheduled monthly financing payment.",
        units: DOLLARS,
        enabledBy: 'paymentMethod "financed"',
        evidence: "export-shape",
      },
      generateIncome: {
        description: "When true, the property generates modeled rental income.",
        evidence: "export-shape",
      },
      "yearlyChange.type": {
        description:
          "How the asset's value moves each year. \"custom\" stores the curve in yearlyChange.custom.",
        allowedValues: [
          "none",
          "appreciate",
          "depreciate",
          "custom",
          "match-inflation",
          "inflation+",
          "inflation-",
        ],
        evidence: "observed",
        note:
          "The asset control labels the pair Appreciate and Depreciate and the curve option Advanced, where income and expense spell the same option Increase and Decrease. The app validates nothing on write, so a token outside this list stores and renders as nothing.",
      },
      taxRate: {
        description: "Annual property tax figure.",
        note: "A dollar amount or a percentage of assessedValue, per taxRateType.",
        evidence: "export-shape",
      },
      maintenanceRate: {
        description: "Annual maintenance cost.",
        note: "A dollar amount or a percentage of market value, per maintenanceRateType.",
        evidence: "export-shape",
      },
      insuranceRate: {
        description: "Annual insurance cost.",
        note: "A dollar amount or a percentage of market value, per insuranceRateType.",
        evidence: "export-shape",
      },
      monthlyHOA: {
        description: "Monthly homeowners association dues.",
        units: DOLLARS,
        enabledBy: "generateIncome",
        evidence: "export-shape",
      },
      "end.type": {
        description:
          "Kind of the end reference: a calendar year, an age, a fixed date, a milestone, a life expectancy, or a keyword.",
        allowedValues: [
          "date",
          "year",
          "age",
          "milestone",
          "lifeExpectancy",
          "lastLifeExpectancy",
          "keyword",
        ],
        evidence: "export-shape",
        note: 'On a one-time event (frequency "once") the end reference is a leftover default: the UI hides it and the simulation ignores it, so it is not a user setting.',
      },
      repeat: {
        description: "When true, the asset is re-acquired on a cadence.",
        evidence: "export-shape",
      },
      sellIfNeeded: {
        description: "When true, the asset is liquidated automatically if the portfolio depletes.",
        evidence: "export-shape",
      },
    },
  },
  {
    scope: "income",
    title: "Plan income events",
    fields: {
      id: {
        description: "Unique event identifier.",
        evidence: "export-shape",
      },
      name: {
        description: "Display label of the income event.",
        evidence: "export-shape",
      },
      kind: {
        description: "Event category discriminator.",
        allowedValues: ["income"],
        evidence: "export-shape",
      },
      type: {
        description: "Income classification type.",
        allowedValues: ["other"],
        evidence: "export-shape",
      },
      amount: {
        description: "Scheduled income amount in dollars.",
        units: DOLLARS,
        evidence: "export-shape",
      },
      "start.type": {
        description: "Timing reference mode for when the income event begins.",
        allowedValues: ["date", "year", "age", "milestone", "lifeExpectancy", "lastLifeExpectancy", "keyword"],
        evidence: "export-shape",
      },
      "start.value": {
        description: "Target date, milestone identifier, or keyword for the start timing.",
        evidence: "export-shape",
      },
      "start.modifier": {
        description: "Optional offset modifier for the start timing.",
        evidence: "export-shape",
      },
      "end.type": {
        description: "Timing reference mode for when the income event ends.",
        allowedValues: ["date", "year", "age", "milestone", "lifeExpectancy", "lastLifeExpectancy", "keyword"],
        evidence: "export-shape",
      },
      "end.value": {
        description: "Target date, milestone identifier, or keyword for the end timing.",
        evidence: "export-shape",
      },
      "end.modifier": {
        description: "Optional offset modifier for the end timing.",
        evidence: "export-shape",
      },
      // Entries carried from the ProjectionLab 4 registry for fields the
      // ProjectionLab 5 export shows.
      owner: {
        description: "Which household member the event belongs to.",
        allowedValues: ["me", "spouse", "joint"],
        evidence: "export-shape",
      },
      estimateIncome: {
        description:
          "When true, the Social Security benefit is estimated from earnings history; when false, amount is entered manually.",
        evidence: "export-shape",
      },
      primaryInsuranceAmount: {
        description:
          "Monthly benefit at full retirement age used by the automatic estimate.",
        units: DOLLARS,
        enabledBy: "estimateIncome",
        evidence: "export-shape",
      },
      expectedPercent: {
        description: "Share of the statutory benefit expected to be paid.",
        units: PCT,
        enabledBy: "estimateIncome",
        note: "100 assumes full benefits; a lower figure models trust fund exhaustion.",
        evidence: "export-shape",
      },
      "yearlyChange.type": {
        description:
          "How the amount changes each year. \"increase\" and \"decrease\" take yearlyChange.amount as a percent, \"custom\" stores a curve in yearlyChange.custom, and \"match-inflation\", \"inflation+\" and \"inflation-\" follow the plan's inflation rate.",
        allowedValues: [
          "none",
          "increase",
          "decrease",
          "custom",
          "match-inflation",
          "inflation+",
          "inflation-",
        ],
        enabledBy: 'frequency other than "once", or amountType "grow$"',
        evidence: "observed",
        note:
          'The Change control offers Increase, Decrease, Advanced ("custom"), Match inflation, and Match inflation plus or minus a percent. A once-frequency event such as an inheritance or a windfall shows no Change control at all, and an amountType of "grow$" brings it back. The app validates nothing on write.',
      },
      "yearlyChange.amount": {
        description:
          "Percent per year applied by yearlyChange.type \"increase\" or \"decrease\".",
        units: PCT,
        enabledBy: 'yearlyChange.type "increase" or "decrease"',
        evidence: "observed",
        note: "The percent per year field in the Change Over Time dialog, beside the Maximum field.",
      },
      "yearlyChange.limit": {
        description: "Dollar ceiling on the value the yearly change may reach.",
        units: DOLLARS,
        enabledBy: 'yearlyChange.limitEnabled with yearlyChange.type "increase" or "decrease"',
        evidence: "observed",
        note:
          'The Maximum field in the Change Over Time dialog is a dollar field. Its unit is held by yearlyChange.limitType, so a percent token there changes nothing on screen.',
      },
      "yearlyChange.limitType": {
        description: "Unit of yearlyChange.limit.",
        allowedValues: ["$", "today$"],
        enabledBy: "yearlyChange.limitEnabled",
        evidence: "observed",
        note:
          'Present on every yearlyChange object examined and always written "today$". The Maximum control offers no percent form.',
      },
      "yearlyChange.custom": {
        description:
          "The curve behind yearlyChange.type \"custom\": { type, data } where type is \"%\", \"$\" or \"today$\" and data is an array of { x, y } points.",
        enabledBy: 'yearlyChange.type "custom"',
        evidence: "observed",
        note:
          "Advanced opens a separate window with the curve editor. x is the year offset from the event start and y is the rate or amount in the unit named by type.",
      },
    },
  },
  {
    scope: "expenses",
    title: "Plan expense events",
    fields: {
      id: {
        description: "Unique event identifier.",
        evidence: "export-shape",
      },
      name: {
        description: "Display label of the expense event.",
        evidence: "export-shape",
      },
      kind: {
        description: "Event category discriminator.",
        allowedValues: ["expense"],
        evidence: "export-shape",
      },
      type: {
        description: "Expense classification type.",
        allowedValues: ["living-expenses"],
        evidence: "export-shape",
      },
      spendingType: {
        description: "How the expense counts towards total spending.",
        allowedValues: ["essential", "discretionary", "hybrid", "none"],
        evidence: "observed",
        note:
          'Offered as Essential, Discretionary, Hybrid ("Count a percentage of this expense as discretionary", the only state that uses discretionaryPercent) and Not Spending.',
      },
      amount: {
        description: "Scheduled expense amount in dollars.",
        units: DOLLARS,
        evidence: "export-shape",
      },
      "start.type": {
        description: "Timing reference mode for when the expense event begins.",
        allowedValues: ["date", "year", "age", "milestone", "lifeExpectancy", "lastLifeExpectancy", "keyword"],
        evidence: "export-shape",
      },
      "start.value": {
        description: "Target date, milestone identifier, or keyword for the start timing.",
        evidence: "export-shape",
      },
      "start.modifier": {
        description: "Optional offset modifier for the start timing.",
        evidence: "export-shape",
      },
      "end.type": {
        description: "Timing reference mode for when the expense event ends.",
        allowedValues: ["date", "year", "age", "milestone", "lifeExpectancy", "lastLifeExpectancy", "keyword"],
        evidence: "export-shape",
      },
      "end.value": {
        description: "Target date, milestone identifier, or keyword for the end timing.",
        evidence: "export-shape",
      },
      "end.modifier": {
        description: "Optional offset modifier for the end timing.",
        evidence: "export-shape",
      },
      // Entries carried from the ProjectionLab 4 registry for fields the
      // ProjectionLab 5 export shows.
      owner: {
        description: "Which household member the event belongs to.",
        allowedValues: ["me", "spouse", "joint"],
        evidence: "export-shape",
      },
      healthcareType: {
        description: "How a healthcare expense is modeled for tax treatment.",
        allowedValues: ["standard", "aca"],
        evidence: "observed",
        note:
          'Labelled Healthcare Type. Offered as Standard, "Regular healthcare expense with no special tax treatment.", and ACA Marketplace, "ACA marketplace plan, with estimated Premium Tax Credit subsidy." The control is offered only on a US plan. The Auto and Manual deductibility selector is a derived chip, not a stored field: taxDeductible is the stored value.',
      },
      taxDeductible: {
        description: "When true, the expense reduces taxable income.",
        evidence: "export-shape",
      },
      repeat: {
        description: "When true, the event repeats on a cadence instead of occurring once.",
        evidence: "export-shape",
      },
      "yearlyChange.type": {
        description:
          "How the amount changes each year. \"increase\" and \"decrease\" take yearlyChange.amount as a percent, \"custom\" stores a curve in yearlyChange.custom, and \"match-inflation\", \"inflation+\" and \"inflation-\" follow the plan's inflation rate.",
        allowedValues: [
          "none",
          "increase",
          "decrease",
          "custom",
          "match-inflation",
          "inflation+",
          "inflation-",
        ],
        enabledBy: 'frequency other than "once", or amountType "grow$"',
        evidence: "observed",
        note:
          "On an expense the pair is labelled Increase Spending and Decrease Spending, each described as changing spending by a certain percentage. The app validates nothing on write, so a token outside this list stores and renders as nothing.",
      },
      "yearlyChange.amount": {
        description:
          "Percent per year applied by yearlyChange.type \"increase\" or \"decrease\".",
        units: PCT,
        enabledBy: 'yearlyChange.type "increase" or "decrease"',
        evidence: "observed",
        note: "The percent per year field in the Change Over Time dialog, beside the Maximum field.",
      },
      "yearlyChange.limit": {
        description: "Dollar ceiling on the value the yearly change may reach.",
        units: DOLLARS,
        enabledBy: 'yearlyChange.limitEnabled with yearlyChange.type "increase" or "decrease"',
        evidence: "observed",
        note:
          'The Maximum field in the Change Over Time dialog is a dollar field. Its unit is held by yearlyChange.limitType, so a percent token there changes nothing on screen.',
      },
      "yearlyChange.limitType": {
        description: "Unit of yearlyChange.limit.",
        allowedValues: ["$", "today$"],
        enabledBy: "yearlyChange.limitEnabled",
        evidence: "observed",
        note:
          'Present on every yearlyChange object examined and always written "today$". The Maximum control offers no percent form.',
      },
      "yearlyChange.custom": {
        description:
          "The curve behind yearlyChange.type \"custom\": { type, data } where type is \"%\", \"$\" or \"today$\" and data is an array of { x, y } points.",
        enabledBy: 'yearlyChange.type "custom"',
        evidence: "observed",
        note:
          "Advanced opens a separate window with the curve editor. x is the year offset from the event start and y is the rate or amount in the unit named by type.",
      },
      fundWithAccounts: {
        description:
          "Plan account event IDs prioritized to pay this expense, such as an HSA for health care or a 529 for education.",
        evidence: "observed",
        note: "Array of accounts.events[].id values in the same plan, not Current Finances account IDs.",
      },
    },
  },
  {
    scope: "priorities",
    title: "Plan priorities (cash flow routing)",
    fields: {
      id: {
        description: "Unique event identifier.",
        evidence: "export-shape",
      },
      name: {
        description: "Display label of the priority flow.",
        evidence: "export-shape",
      },
      kind: {
        description: "Event category discriminator.",
        allowedValues: ["priority"],
        evidence: "export-shape",
      },
      type: {
        description: "Priority routing target type.",
        allowedValues: ["taxable"],
        evidence: "export-shape",
      },
      accountId: {
        description:
          "Identifier of the plan account event this priority routes cash to (an accounts.events[].id in the same plan), not a Current Finances account ID.",
        evidence: "export-shape",
      },
      // Entries carried from the ProjectionLab 4 registry for fields the
      // ProjectionLab 5 export shows.
      desiredContribution: {
        description: "How much the flow receives from surplus cash flow.",
        allowedValues: ["max", "%-remaining", "amount", "%-balance"],
        evidence: "observed",
        note:
          'Offered as Maximize Contribution ("max"), % of Remaining Income ("%-remaining") and Specific Amount ("amount"). "%-balance", % of Remaining Balance, is a real token the flow editor does not request: only the extra-contribution control asks for it, so a flow normally holds one of the first three.',
      },
      amount: {
        description: 'Dollar amount the flow takes when desiredContribution is "amount".',
        units: DOLLARS,
        evidence: "export-shape",
      },
    },
  },
  {
    scope: "milestones",
    title: "Plan milestones",
    fields: {
      id: {
        description: "Unique identifier of the milestone.",
        evidence: "export-shape",
      },
      name: {
        description: "Display label of the milestone.",
        evidence: "export-shape",
      },
      "criteria.*.type": {
        description: "Kind of milestone criterion.",
        allowedValues: ["date", "year", "milestone", "netWorth", "totalDebt", "age"],
        evidence: "export-shape",
      },
      "criteria.*.value": {
        description: "Target value of the criterion.",
        evidence: "export-shape",
      },
      "criteria.*.modifier": {
        description: "Offset modifier for the criterion.",
        evidence: "export-shape",
      },
      "criteria.*.years": {
        description: "Age the criterion is met at, for an age criterion.",
        units: YEARS,
        evidence: "export-shape",
      },
      "criteria.*.precision": {
        description: "How finely an age criterion is resolved.",
        evidence: "export-shape",
        note: 'Observed value: "yearly".',
      },
    },
  },
  VARIABLES_V5_GROUP,
  MONTECARLO_V5_GROUP,
  WITHDRAWAL_STRATEGY_V5_GROUP,
  {
    scope: "settings",
    title: "Application and plan settings",
    fields: {
      schema: {
        description: "Settings document schema version (5 in ProjectionLab 5).",
        units: "count",
        evidence: "export-shape",
      },
      seenVersion: {
        description: "Last recorded application version.",
        evidence: "export-shape",
      },
      "plan.activeId": {
        description: "Active plan identifier in the application interface. Reported as stored; it does not tell which plan the user is working in, and the server never treats it as the selected plan.",
        evidence: "export-shape",
      },
      "plan.baselineId": {
        description: "Baseline comparison plan identifier. Reported as stored.",
        evidence: "export-shape",
      },
      "plan.alignment.type": {
        description:
          "Account year alignment: where each plan year starts, for every plan without its own alignment.",
        allowedValues: ALIGNMENT_TYPES,
        evidence: "observed",
        note: ALIGNMENT_NOTE,
      },
      "plan.alignment.date": {
        description: ALIGNMENT_DATE_DESCRIPTION,
        enabledBy: 'plan.alignment.type "custom", "au-tax" or "uk-tax"',
        evidence: "observed",
      },
      "plan.tabs.pinned": {
        description: "Whether plan tabs are pinned in the interface.",
        evidence: "export-shape",
      },
      "plugins.enabled": {
        description: "Whether the Plugin API is enabled.",
        evidence: "export-shape",
      },
      "plugins.apiKey": {
        description: "Secret authentication key for the Plugin API (redacted on reads).",
        evidence: "export-shape",
      },
    },
  },
  {
    scope: "accountHistory",
    title: "Account history",
    fields: {
      "*.*.schema": {
        description: "History record schema version (5 in ProjectionLab 5).",
        units: "count",
        evidence: "export-shape",
        note: "Keyed by account ID then calendar year.",
      },
      "*.*.kind": {
        description: "Account category discriminator.",
        allowedValues: ["account", "real-asset"],
        evidence: "export-shape",
      },
      "*.*.balance.*": {
        description: "Historical end-of-year balance in dollars for an account, keyed by account ID.",
        units: DOLLARS,
        evidence: "export-shape",
      },
      "*.*.costBasis.*": {
        description: "Historical end-of-year cost basis in dollars for an account, keyed by account ID.",
        units: DOLLARS,
        evidence: "export-shape",
      },
      "*.*.value.*": {
        description: "Historical end-of-year estimated value in dollars for a real asset, keyed by asset ID.",
        units: DOLLARS,
        evidence: "export-shape",
      },
    },
  },
];

/**
 * On-screen labels in ProjectionLab 5.0.0, keyed by scope then path. Each was
 * found in the app by writing a distinct value to the field, or by matching a
 * stored value to the control that shows it.
 */
const RATES = "Plan Settings > Rates";
const TAX = "Plan Settings > Tax";
const ESTATE = "Plan overview > Estate Settings";
const MC_DATA = "Chance of Success > Data Sources";
const TEXTBOOK = "Optimize > Drawdown Strategy > Textbook Withdrawals";
const strategyAt = (name: string) => `${TEXTBOOK}, Strategy "${name}"`;
const INCOME = "Plan > income event";
const EXPENSE = "Plan > expense event";
const DETAILS = "Net Worth > account or asset > Details (also the Details tab in the plan)";
const ACCOUNT_PLAN = "Plan > Accounts > account > Plan";
const ACCOUNT_SETTINGS = "Plan > Accounts > account > Settings";
const ASSET_PLAN = "Plan > real asset > Plan";
const FLOW = "Plan > Flows > flow";
const HOUSEHOLD = "Profile menu > Household";
const changeOverTime = (event: string) => ({
  "yearlyChange.type": ["Change", `${event} > Change Over Time`],
  "yearlyChange.amount": ["Percent per year", `${event} > Change Over Time (Increase or Decrease)`],
  "yearlyChange.limit": ["Maximum", `${event} > Change Over Time (Increase or Decrease)`],
}) as const;

export const UI_LABELS_V5: Readonly<
  Record<string, Readonly<Record<string, readonly [label: string, location: string]>>>
> = {
  variables: {
    inflation: ["Inflation Rate", `${RATES} (Fixed mode)`],
    investmentReturn: ["Stock Growth Rate", `${RATES} (Fixed mode)`],
    dividendRate: ["Stock Dividend Yield", `${RATES} (Fixed mode)`],
    bondInvestmentReturn: ["Bond Growth Rate", `${RATES} (Fixed mode)`],
    bondDividendRate: ["Bond Yield", `${RATES} (Fixed mode)`],
    benefitColaModifier: ["Benefit COLA Modifier", RATES],
    startYear: ["Start Year", `${RATES} (Historical mode)`],
    loopYear: ["Loopback Year", `${RATES} (Historical mode)`],
    "dividendSettings.composition.qualifiedPercent": [
      "Qualified Dividends",
      "Plan Settings > Dividends > Stock Dividend Composition",
    ],
    "bondSettings.composition.municipalPercent": [
      "Municipal Bonds",
      "Plan Settings > Bonds > Bond Income Composition",
    ],
    "bondSettings.composition.treasuryPercent": [
      "Treasury / Government",
      "Plan Settings > Bonds > Bond Income Composition",
    ],
    "withholding.taxDeferred": ["Tax-Deferred Withdrawals", `${TAX} > Withholding`],
    "withholding.taxable": ["Taxable Withdrawals", `${TAX} > Withholding`],
    "withholding.conversions": ["Conversions", `${TAX} > Withholding`],
    incomeTaxModifier: ["Income Tax Modifier", `${TAX} > More Options`],
    capGainsModifier: ["Capital Gains Tax Modifier", `${TAX} > More Options`],
    "taxStrategy.bracketRate": ["Tax Bracket", "Plan overview > Tax Strategy"],
    "estate.taxDeferredRate": ["Tax-Deferred Account Tax Rate", ESTATE],
    "estate.assetLiquidationFee": ["Liquidation Costs", ESTATE],
    "estate.charityRate": ["Charitable Giving", ESTATE],
    "estate.adminRate": ["Administrative Costs", ESTATE],
  },
  montecarlo: {
    investmentReturnMean: ["Mean", `${MC_DATA} > Stock Growth Rate`],
    investmentReturnStdDev: ["Std. Dev.", `${MC_DATA} > Stock Growth Rate`],
    dividendRateMean: ["Mean", `${MC_DATA} > Stock Dividend Yield`],
    dividendRateStdDev: ["Std. Dev.", `${MC_DATA} > Stock Dividend Yield`],
    inflationMean: ["Mean", `${MC_DATA} > Inflation`],
    inflationStdDev: ["Std. Dev.", `${MC_DATA} > Inflation`],
    bondReturnMean: ["Mean", `${MC_DATA} > Bond Returns (Normal Distribution)`],
    bondReturnStdDev: ["Std. Dev.", `${MC_DATA} > Bond Returns (Normal Distribution)`],
  },
  withdrawalStrategy: {
    enabled: ["Textbook Strategy", TEXTBOOK],
    "initial-%.amount": ["Initial Withdrawal", strategyAt("Initial Percentage")],
    "fixed-%.amount": ["Yearly Withdrawal", strategyAt("Fixed Percentage")],
    "fixed-amount.amount": ["The amount withdrawn each year", strategyAt("Fixed Amount")],
    "kitces-ratchet.amount": [
      "Initial Withdrawal",
      strategyAt("Ratcheting Safe Withdrawal Rate"),
    ],
    "kitces-ratchet.threshold": [
      "Ratchet Threshold",
      strategyAt("Ratcheting Safe Withdrawal Rate"),
    ],
    "kitces-ratchet.ratchet": [
      "Ratchet Increase",
      strategyAt("Ratcheting Safe Withdrawal Rate"),
    ],
    "kitces-ratchet.cooldown": [
      "The years to wait between ratchets",
      strategyAt("Ratcheting Safe Withdrawal Rate"),
    ],
    "clyatt-95%.amount": ["Portfolio Share", strategyAt("Clyatt 95% Rule")],
    "clyatt-95%.percentOfPrevious": [
      "Previous Withdrawal Floor",
      strategyAt("Clyatt 95% Rule"),
    ],
    "guyton-klinger.amount": ["Initial Withdrawal", strategyAt("Guyton-Klinger")],
    "guyton-klinger.guardrail": ["Guardrail", strategyAt("Guyton-Klinger")],
    "guyton-klinger.adjustment": ["Adjustment", strategyAt("Guyton-Klinger")],
  },
  income: {
    amount: ["Amount", `${INCOME} (Enter Amount mode for Social Security)`],
    owner: ["Earner", INCOME],
    estimateIncome: ["Estimate Benefit or Enter Amount", `${INCOME} (Social Security)`],
    primaryInsuranceAmount: [
      "Primary Insurance Amount",
      `${INCOME} (Social Security, Estimate Benefit mode)`,
    ],
    expectedPercent: ["Expected Percentage", `${INCOME} (Social Security)`],
    ...changeOverTime(INCOME),
  },
  expenses: {
    amount: ["Amount", EXPENSE],
    owner: ["Spender", EXPENSE],
    spendingType: ["Spending Type", `${EXPENSE} > Flexibility`],
    healthcareType: ["Healthcare Type", `${EXPENSE} (health care)`],
    taxDeductible: ["Tax-Deductible", EXPENSE],
    fundWithAccounts: ["Funding Source", `${EXPENSE} > Pay From`],
    repeat: ["Recurrence", `${EXPENSE} (More Options > Advanced Options on)`],
    ...changeOverTime(EXPENSE),
  },
  accounts: {
    name: ["Name", DETAILS],
    owner: ["Owner", DETAILS],
    type: ["Type", DETAILS],
    balance: ["Balance", DETAILS],
    costBasis: ["Cost Basis", `${DETAILS} ("Past Contributions" on a Roth account)`],
    value: ["Current Value", DETAILS],
    purchasePrice: ["Purchase Price", DETAILS],
    investmentGrowthRate: ["Growth Rate", `${ACCOUNT_PLAN} > Growth`],
    dividendRate: ["Dividend Yield", `${ACCOUNT_PLAN} > Growth`],
    yearlyFee: ["Yearly Fee", `${ACCOUNT_PLAN} > Fees`],
    withdraw: ["Withdrawals", `${ACCOUNT_PLAN} > Withdrawals`],
    withdrawAge: ["Withdrawals", `${ACCOUNT_PLAN} > Withdrawals`],
    rmdType: ["Rules", `${ACCOUNT_PLAN} > RMDs`],
    EWAge: ["Qualified Age", ACCOUNT_SETTINGS],
    hasEWPenalty: ["Early Withdrawal Penalties", ACCOUNT_SETTINGS],
    EWPenaltyRate: ["Penalty Rate", ACCOUNT_SETTINGS],
  },
  assets: {
    value: ["Current Value", DETAILS],
    purchasePrice: ["Purchase Price", DETAILS],
    "start.type": ["Purchase Date", `${ASSET_PLAN} > Purchase (future purchase)`],
    paymentMethod: ["Payment Method", `${ASSET_PLAN} > Purchase (future purchase)`],
    downPayment: ["Down Payment", `${ASSET_PLAN} > Financing`],
    interestRate: ["Annual Percentage Rate", `${ASSET_PLAN} > Financing`],
    interestType: ["Interest Type", `${ASSET_PLAN} > Financing`],
    compounding: ["Compounding", `${ASSET_PLAN} > Financing`],
    monthlyPayment: ["Monthly Payment", `${ASSET_PLAN} > Financing`],
    generateIncome: ["Generate rental income", `${ASSET_PLAN} > Usage`],
    "yearlyChange.type": ["Change Over Time", `${ASSET_PLAN} > Change Over Time`],
    taxRate: ["Yearly Property Tax", `${ASSET_PLAN} > Taxes ("Taxes" on a vehicle)`],
    maintenanceRate: ["Yearly Maintenance Costs", `${ASSET_PLAN} > Expenses`],
    insuranceRate: ["Yearly Insurance Costs", `${ASSET_PLAN} > Expenses`],
    monthlyHOA: ["Monthly HOA Fees", `${ASSET_PLAN} > Expenses`],
    "end.type": ["Timing", `${ASSET_PLAN} > Sale`],
    repeat: ["Repeat", `${ASSET_PLAN} > Recurrence`],
    sellIfNeeded: ["Liquidate if Necessary", `${ASSET_PLAN} > More Options`],
  },
  priorities: {
    accountId: ["Account", FLOW],
    amount: ["Funding", FLOW],
    desiredContribution: ["Goal", `${FLOW} (offered as Maximize Contribution, % of Remaining Income or Specific Amount)`],
  },
  currentFinances: {
    "household.people.me.name": ["First Name", HOUSEHOLD],
    "household.people.me.birthYear": ["Born", HOUSEHOLD],
    "household.people.me.lifeExpectancy": ["Life Expectancy", HOUSEHOLD],
    "household.people.spouse.name": ["First Name", `${HOUSEHOLD} (partner)`],
    "household.people.spouse.birthYear": ["Born", `${HOUSEHOLD} (partner)`],
    "household.people.spouse.lifeExpectancy": ["Life Expectancy", `${HOUSEHOLD} (partner)`],
  },
};

for (const [scope, labels] of Object.entries(UI_LABELS_V5)) {
  const groups = DATA_MODEL_V5_GROUPS.filter(
    (candidate) => candidate.scope === scope,
  );
  for (const [path, [label, location]] of Object.entries(labels)) {
    const fields = groups.flatMap((group) => group.fields[path] ?? []);
    if (fields.length === 0) {
      throw new Error(`UI label for unknown data model path ${scope}.${path}`);
    }
    for (const field of fields) {
      field.uiLabel = label;
      field.uiLocation = location;
    }
  }
}

interface CompiledEntry {
  pattern: string;
  segments: string[];
  field: DataModelField;
}

const compiledByScope = new Map<string, CompiledEntry[]>();
for (const group of DATA_MODEL_V5_GROUPS) {
  const entries: CompiledEntry[] = [];
  for (const [pattern, field] of Object.entries(group.fields)) {
    entries.push({ pattern, segments: pattern.split("."), field });
  }
  compiledByScope.set(group.scope, entries);
}

function entryMatches(segments: string[], pathSegments: string[]): boolean {
  if (segments.length !== pathSegments.length) return false;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== "*" && segments[i] !== pathSegments[i]) return false;
  }
  return true;
}

/** The data model groups. */
export function getDataModelGroups(): readonly DataModelGroup[] {
  return DATA_MODEL_V5_GROUPS;
}

/** Field entry for a scope-prefixed concrete path, or undefined. */
export function matchDataModelField(
  scope: string,
  path: string,
): DataModelField | undefined {
  const entries = compiledByScope.get(scope);
  if (!entries) return undefined;
  const exact = entries.find((entry) => entry.pattern === path);
  if (exact) return exact.field;
  const pathSegments = path.split(".");
  for (const entry of entries) {
    if (!entry.pattern.includes("*")) continue;
    if (entryMatches(entry.segments, pathSegments)) return entry.field;
  }
  return undefined;
}

/**
 * Whether a write of a value outside an entry's `allowedValues` is refused.
 * Only an observed entry binds a write: its field is confirmed by a
 * stored-value test and its list is held as the app's own set of choices. A
 * ui-label or export-shape list is a hint and may leave choices the app offers
 * out of it.
 */
export function enforcesAllowedValues(field: DataModelField): boolean {
  return field.evidence === "observed";
}

export interface DataModelAnnotation {
  description?: string;
  units?: string;
  allowedValues?: readonly string[];
  /**
   * Present whenever `allowedValues` is: true when a write outside the list is
   * refused, false when the list is a hint that may leave choices out.
   */
  allowedValuesEnforced?: boolean;
  uiLabel?: string;
  uiLocation?: string;
}

/**
 * Copy listed values, attaching description, units, allowedValues with its
 * allowedValuesEnforced, and the ProjectionLab 5.0.0 uiLabel and uiLocation for
 * paths with a registry entry. Entries for unknown paths are returned
 * unchanged, so existing listPaths fields never change.
 */
export function annotateAddressableValues<T extends { path: string }>(
  scope: string | undefined,
  values: readonly T[],
): (T & DataModelAnnotation)[] {
  return values.map((value) => {
    const field = scope ? matchDataModelField(scope, value.path) : undefined;
    if (!field) return value;
    const annotated: T & DataModelAnnotation = { ...value };
    annotated.description = field.description;
    if (field.units) annotated.units = field.units;
    if (field.allowedValues) {
      annotated.allowedValues = field.allowedValues;
      annotated.allowedValuesEnforced = enforcesAllowedValues(field);
    }
    if (field.uiLabel) annotated.uiLabel = field.uiLabel;
    if (field.uiLocation) annotated.uiLocation = field.uiLocation;
    return annotated;
  });
}

/**
 * Choices to refuse a value over: an observed enum's list when value is a
 * string outside it. undefined when no refusal applies. Numeric and boolean
 * values are never refused; ui-label enums are annotated but not enforced.
 */
export function refusedEnumChoices(
  scope: string | undefined,
  path: string,
  value: unknown,
): readonly string[] | undefined {
  if (scope === undefined || typeof value !== "string") return undefined;
  const field = matchDataModelField(scope, path);
  if (!field?.allowedValues || !enforcesAllowedValues(field)) return undefined;
  if (field.allowedValues.includes(value)) return undefined;
  return field.allowedValues;
}

/** Refusal for a value a write sets outside an observed enum's choices. */
export function enumRefusalError(
  scope: string,
  path: string,
  value: unknown,
): ProjectionLabError | undefined {
  const choices = refusedEnumChoices(scope, path, value);
  if (!choices) return undefined;
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  return new ProjectionLabError(
    "INVALID_INPUT",
    `Invalid value ${shown} for "${scope}.${path}". Allowed values: ${choices.join(", ")}.`,
    `Write one of the listed values, or inspect projectionlab://data-model for what "${path}" means and what enables it.`,
  );
}
