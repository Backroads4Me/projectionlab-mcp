import type { PlanSettingSection } from "./planSettings.js";

/**
 * The topic layout of the plan settings report. Topics are listed in reading
 * order: the settings a user sets on screen and adjusts most come first, the
 * automatic, internal and rarely changed ones last.
 *
 * A row's name is its ProjectionLab 5 on-screen label (UI_LABELS_V5) when one
 * is recorded. `name` is the report's own descriptive wording for a setting
 * without one; it is never added to UI_LABELS_V5, which holds confirmed
 * labels only. Every path is relative to the topic's section.
 */

export type ReportTier = "main" | "more" | "advanced";

export const TIER_TITLES: Record<ReportTier, string> = {
  main: "Main settings",
  more: "More settings",
  advanced: "Advanced and automatic settings",
};

/**
 * How a row reads its value:
 * - "value": the stored value at `path`.
 * - "reference": a { type, value, modifier } start or end reference.
 * - "bound": a withdrawal bound stored as `path`, `pathEnabled`, `pathType`.
 * - "curve": a { type, data: [ { x, y } ] } rate curve.
 * - "points": an array of { x, y } points whose y is a percentage.
 * - "accounts": an array of plan account event ids, shown by account name.
 * - "order": an ordered list, shown first to last.
 */
export type RowKind =
  | "value"
  | "reference"
  | "bound"
  | "curve"
  | "points"
  | "accounts"
  | "order";

/** A field the row applies under: `path` equals `equals`, or is truthy when
 * `equals` is undefined. */
export interface RowCondition {
  path: string;
  equals?: unknown;
}

export interface TopicRow {
  path: string;
  kind?: RowKind;
  /** Descriptive name for a setting with no recorded on-screen label. */
  name?: string;
  /** Prefix for an on-screen label that only reads in context ("Mean"). */
  context?: string;
}

export interface ReportTopic {
  title: string;
  tier: ReportTier;
  section: PlanSettingSection;
  rows: TopicRow[];
  /** Conditions every row of the topic applies under. */
  appliesWhen?: RowCondition[];
  /** Conditions for single rows, by path, beyond the data model's enabledBy. */
  rowAppliesWhen?: Record<string, RowCondition[]>;
}

/**
 * Value names: the withdrawal strategies by the names ProjectionLab 5 shows
 * (UI_LABELS_V5 strategy locations), the dollar bases, the filing statuses,
 * and descriptive names for the withdrawal order's elements (the
 * drawdownOrder note lists them). Other values are shown as stored, or split
 * into words when the data model lists them as allowed values.
 */
export const VALUE_NAMES: Record<string, Record<string, string>> = {
  strategy: {
    "initial-%": "Initial Percentage",
    "fixed-%": "Fixed Percentage",
    "fixed-amount": "Fixed Amount",
    "kitces-ratchet": "Ratcheting Safe Withdrawal Rate",
    // The variable percentage withdrawal rule, by its acronym.
    vpw: "VPW",
    "1/N": "1/N",
    "clyatt-95%": "Clyatt 95% Rule",
    "guyton-klinger": "Guyton-Klinger",
  },
  dollarBasis: {
    today$: "today's dollars",
    future$: "future dollars",
  },
  // drawdownOrder note: the elements of the withdrawal order.
  drawdownOrder: {
    "excess-cash": "Excess cash",
    taxable: "Taxable",
    "hsa-medical": "HSA (medical)",
    "ira/401k": "IRA/401k",
    "free-roth-ira-contributions": "Roth IRA contributions",
    "roth-ira": "Roth IRA",
    "non-qualified-ira/401k": "Non-qualified IRA/401k",
    "non-qualified-roth": "Non-qualified Roth",
    "non-qualified-hsa": "Non-qualified HSA",
    "all-cash": "All cash",
  },
  filingStatus: {
    single: "Single",
    joint: "Married filing jointly",
    "head-of-household": "Head of household",
    separate: "Married filing separately",
  },
};

/** Which VALUE_NAMES table a path's values are named from. */
export function valueNamesFor(path: string): Record<string, string> | undefined {
  if (path === "strategy") return VALUE_NAMES.strategy;
  if (path === "filingStatus") return VALUE_NAMES.filingStatus;
  if (path === "drawdownOrder") return VALUE_NAMES.drawdownOrder;
  if (path.endsWith("amountType")) return VALUE_NAMES.dollarBasis;
  return undefined;
}

const rates = (path: string) => ({ path });

/** Withdrawal strategy codes in the order ProjectionLab lists them. */
const WITHDRAWAL_STRATEGIES: readonly {
  code: string;
  title: string;
  rows: TopicRow[];
}[] = [
  { code: "initial-%", title: "Initial Percentage", rows: [{ path: "initial-%.amount" }] },
  { code: "fixed-%", title: "Fixed Percentage", rows: [{ path: "fixed-%.amount" }] },
  {
    code: "fixed-amount",
    title: "Fixed Amount",
    rows: [
      { path: "fixed-amount.amount" },
      { path: "fixed-amount.amountType", name: "Amount is in" },
      { path: "fixed-amount.adjust", name: "Adjust for inflation" },
    ],
  },
  {
    code: "kitces-ratchet",
    title: "Ratcheting Safe Withdrawal Rate",
    rows: [
      { path: "kitces-ratchet.amount" },
      { path: "kitces-ratchet.threshold" },
      { path: "kitces-ratchet.ratchet" },
      { path: "kitces-ratchet.cooldown" },
    ],
  },
  { code: "vpw", title: "VPW", rows: [] },
  { code: "1/N", title: "1/N", rows: [] },
  {
    code: "clyatt-95%",
    title: "Clyatt 95% Rule",
    rows: [
      { path: "clyatt-95%.amount" },
      { path: "clyatt-95%.percentOfPrevious" },
    ],
  },
  {
    code: "guyton-klinger",
    title: "Guyton-Klinger",
    rows: [
      { path: "guyton-klinger.amount" },
      { path: "guyton-klinger.guardrail" },
      { path: "guyton-klinger.adjustment" },
    ],
  },
];

// The withdrawalStrategy data model: `enabled` applies the active rule, and
// the rule's parameters live under the key `strategy` names.
const TEXTBOOK_ON: RowCondition = { path: "enabled", equals: true };

const strategyTopics: ReportTopic[] = WITHDRAWAL_STRATEGIES.map((strategy) => ({
  title: `Withdrawal strategy: ${strategy.title}`,
  tier: "main",
  section: "withdrawalStrategy",
  appliesWhen: [TEXTBOOK_ON, { path: "strategy", equals: strategy.code }],
  rows: [
    ...strategy.rows,
    { path: `${strategy.code}.min`, kind: "bound", name: "Minimum withdrawal" },
    { path: `${strategy.code}.max`, kind: "bound", name: "Maximum withdrawal" },
  ],
}));

// assumptionsMode note: "custom" enables the *Custom curve objects.
const CUSTOM_RATES: RowCondition = { path: "assumptionsMode", equals: "custom" };

export const REPORT_TOPICS: readonly ReportTopic[] = [
  {
    title: "Growth and inflation",
    tier: "main",
    section: "variables",
    rowAppliesWhen: {
      inflationCustom: [CUSTOM_RATES],
      investmentReturnCustom: [CUSTOM_RATES],
      dividendRateCustom: [CUSTOM_RATES],
      bondInvestmentReturnCustom: [CUSTOM_RATES],
      bondDividendRateCustom: [CUSTOM_RATES],
    },
    rows: [
      { path: "assumptionsMode", name: "Rates mode" },
      rates("inflation"),
      rates("investmentReturn"),
      rates("dividendRate"),
      rates("bondInvestmentReturn"),
      rates("bondDividendRate"),
      rates("benefitColaModifier"),
      rates("startYear"),
      rates("loopYear"),
      { path: "inflationCustom", kind: "curve", name: "Inflation curve" },
      { path: "investmentReturnCustom", kind: "curve", name: "Stock growth curve" },
      { path: "dividendRateCustom", kind: "curve", name: "Stock dividend curve" },
      { path: "bondInvestmentReturnCustom", kind: "curve", name: "Bond growth curve" },
      { path: "bondDividendRateCustom", kind: "curve", name: "Bond yield curve" },
    ],
  },
  {
    title: "Spending and withdrawals",
    tier: "main",
    section: "variables",
    rows: [
      { path: "drawdownOrder", kind: "order", name: "Withdrawal order" },
      { path: "cashFlowDefault", name: "Leftover cash each year" },
      { path: "drawdownBlendingStrategy.enabled", name: "Withdrawal shielding and blending" },
    ],
  },
  {
    title: "Withdrawal strategy",
    tier: "main",
    section: "withdrawalStrategy",
    rowAppliesWhen: {
      strategy: [TEXTBOOK_ON],
      start: [TEXTBOOK_ON],
      income: [TEXTBOOK_ON],
      spendMode: [TEXTBOOK_ON],
    },
    rows: [
      { path: "enabled" },
      { path: "strategy", name: "Strategy" },
      { path: "start", kind: "reference", name: "Starts at" },
      { path: "income", name: "Planned income" },
      { path: "spendMode", name: "Withdraw or spend target" },
    ],
  },
  ...strategyTopics,
  {
    title: "Tax strategy and Roth conversions",
    tier: "main",
    section: "variables",
    rows: [
      { path: "taxStrategy.type", name: "Tax strategy" },
      { path: "taxStrategy.bracketRate" },
      { path: "taxStrategy.capGainsBracketRate", name: "Capital gains bracket" },
      { path: "rothConversionStrategy.enabled", name: "Roth conversions" },
      { path: "rothConversionStrategy.start", kind: "reference", name: "Roth conversions start" },
      { path: "rothConversionStrategy.end", kind: "reference", name: "Roth conversions end" },
      { path: "gainHarvestingStrategy.enabled", name: "Capital gains harvesting" },
      { path: "taxStrategy.acaCeiling", name: "Protect ACA subsidies" },
      { path: "taxStrategy.federalPovertyLevelMultiple", name: "ACA poverty level multiple" },
      { path: "taxStrategy.irmaaCeiling", name: "Stay below IRMAA cliffs" },
      { path: "taxStrategy.irmaaCliffIndex", name: "IRMAA cliff to stay below" },
      { path: "taxStrategy.niitCeiling", name: "Stay below the NIIT threshold" },
    ],
  },
  {
    title: "Taxes",
    tier: "main",
    section: "variables",
    rows: [
      { path: "estimateTaxes", name: "Estimate taxes" },
      { path: "filingStatus", name: "Filing status" },
      { path: "withholding.taxDeferred" },
      { path: "withholding.taxable" },
      { path: "withholding.conversions" },
      { path: "incomeTaxModifier" },
      { path: "capGainsModifier" },
      { path: "bbbSaltReversion", name: "SALT cap increase expires" },
      { path: "bbbSeniorReversion", name: "Senior deduction expires" },
    ],
  },
  {
    title: "Bonds and dividends",
    tier: "main",
    section: "variables",
    rows: [
      { path: "bondSettings.allocationType", name: "Bond allocation" },
      { path: "bondSettings.allocation", kind: "points", name: "Bond allocation points" },
      { path: "bondSettings.location.type", name: "Bond placement" },
      { path: "bondSettings.location.accountOrder", kind: "accounts", name: "Bond account order" },
      { path: "bondSettings.composition.municipalPercent" },
      { path: "bondSettings.composition.treasuryPercent" },
      { path: "dividendSettings.composition.qualifiedPercent" },
      { path: "dividendSettings.reinvestment.enabled", name: "Reinvest dividends" },
      { path: "dividendSettings.composition.country", name: "Dividend tax country" },
    ],
  },
  {
    title: "Estate",
    tier: "more",
    section: "variables",
    rows: [
      { path: "estate.taxDeferredRate" },
      { path: "estate.stepUpBasis", name: "Step-up in basis at death" },
      { path: "estate.taxableGainsRate", name: "Taxable account gains rate" },
      { path: "estate.assetLiquidationFee" },
      { path: "estate.charityRate" },
      { path: "estate.adminRate" },
    ],
  },
  {
    title: "Chance of Success",
    tier: "more",
    section: "montecarlo",
    rows: [
      { path: "trials", name: "Trials" },
      { path: "mode", name: "Data sources" },
      { path: "sampling", name: "Sampling" },
      { path: "blockSize", name: "Block size (years)" },
      { path: "investmentReturn", name: "Stock growth source" },
      { path: "investmentReturnMean", context: "Stock Growth Rate" },
      { path: "investmentReturnStdDev", context: "Stock Growth Rate" },
      { path: "dividendRate", name: "Stock dividend source" },
      { path: "dividendRateMean", context: "Stock Dividend Yield" },
      { path: "dividendRateStdDev", context: "Stock Dividend Yield" },
      { path: "inflation", name: "Inflation source" },
      { path: "inflationMean", context: "Inflation" },
      { path: "inflationStdDev", context: "Inflation" },
      { path: "bondReturn", name: "Bond return source" },
      { path: "bondReturnMean", context: "Bond Returns" },
      { path: "bondReturnStdDev", context: "Bond Returns" },
      { path: "cryptoReturn", name: "Crypto return source" },
      { path: "cryptoReturnMean", name: "Crypto return mean" },
      { path: "cryptoReturnStdDev", name: "Crypto return standard deviation" },
      { path: "trialMetric", name: "Success measured by" },
      { path: "statsMetric", name: "Percentile chart shows" },
    ],
  },
  {
    title: "Tax rules and tables",
    tier: "advanced",
    section: "variables",
    rows: [
      { path: "medicare", name: "Medicare" },
      { path: "irmaa", name: "IRMAA" },
      { path: "tcjaReversion", name: "TCJA reversion" },
      { path: "incomeTaxMode", name: "Income tax mode" },
      { path: "effectiveIncomeTaxRate", name: "Effective income tax rate" },
      { path: "localIncomeTaxRate", name: "Local income tax rate" },
      { path: "incomeTaxNational.name", name: "National income tax name" },
      { path: "incomeTaxNational.standardDeduction", name: "National income tax standard deduction" },
      { path: "incomeTaxNational.brackets", name: "National income tax brackets" },
      { path: "incomeTaxNational.icon", name: "National income tax icon" },
      { path: "incomeTaxExtra", name: "Additional income taxes" },
      { path: "capGainsMode", name: "Capital gains tax mode" },
      { path: "capGainsTaxRate", name: "Capital gains tax rate" },
      { path: "capGainsTaxablePercent", name: "Capital gains taxable percent" },
      { path: "capGainsTaxAsIncome", name: "Tax capital gains as income" },
      { path: "capGains.brackets", name: "Capital gains brackets" },
      { path: "capGains.offset", name: "Capital gains brackets offset" },
      { path: "dividendTaxMode", name: "Dividend tax mode" },
      { path: "dividendTaxRate", name: "Dividend tax rate" },
      { path: "dividendTax.allowance", name: "Dividend tax allowance" },
      { path: "dividendTax.brackets", name: "Dividend tax brackets" },
      { path: "dividendTax.offset", name: "Dividend tax brackets offset" },
      { path: "bondDividendTaxMode", name: "Bond income tax mode" },
      { path: "bondDividendTaxRate", name: "Bond income tax rate" },
      { path: "bondDividendTax.brackets", name: "Bond income tax brackets" },
      { path: "bondDividendTax.offset", name: "Bond income tax brackets offset" },
    ],
  },
  {
    title: "Wealth and transaction taxes",
    tier: "advanced",
    section: "variables",
    rows: [
      { path: "wealthTaxMode", name: "Wealth tax mode" },
      { path: "wealthTaxRate", name: "Wealth tax rate" },
      { path: "wealthTaxMetric", name: "Wealth tax measured on" },
      { path: "wealthTax.allowance", name: "Wealth tax allowance" },
      { path: "wealthTax.standardDeduction", name: "Wealth tax standard deduction" },
      { path: "wealthTax.brackets", name: "Wealth tax brackets" },
      { path: "fttMode", name: "Transaction tax mode" },
      { path: "fttRate", name: "Transaction tax rate" },
      { path: "fttTaxableEvent", name: "Transaction tax applies to" },
    ],
  },
  {
    title: "Rate adjustments",
    tier: "advanced",
    section: "variables",
    rows: [
      { path: "inflationModifier", name: "Inflation adjustment" },
      { path: "investmentReturnModifier", name: "Stock growth adjustment" },
      { path: "dividendRateModifier", name: "Stock dividend adjustment" },
      { path: "bondInvestmentReturnModifier", name: "Bond growth adjustment" },
      { path: "bondDividendRateModifier", name: "Bond yield adjustment" },
    ],
  },
  {
    title: "Flexible spending",
    tier: "advanced",
    section: "variables",
    rows: [
      { path: "flexSpending.enabled", name: "Flexible spending" },
      { path: "flexSpending.scope", name: "Flexible spending applies to" },
      { path: "flexSpending.interpolation", name: "Flexible spending interpolation" },
      { path: "flexSpending.points", name: "Flexible spending points" },
    ],
  },
  {
    title: "Projection and display",
    tier: "advanced",
    section: "variables",
    rows: [
      { path: "startDate", name: "Plan start date" },
      { path: "projectFrom", name: "Project from" },
      { path: "showFutureDollars", name: "Show future dollars" },
      { path: "showRothConversionIcons", name: "Show Roth conversion icons" },
    ],
  },
  {
    title: "Simulation internals",
    tier: "advanced",
    section: "montecarlo",
    rows: [
      { path: "iterations", name: "Worker tasks" },
      { path: "metrics", name: "Metrics tracked" },
      { path: "metric", name: "Metric" },
      { path: "splitPoint", name: "Split point" },
      { path: "splitPointModifier", name: "Split point modifier" },
    ],
  },
];
