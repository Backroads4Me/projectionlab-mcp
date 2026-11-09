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
 * Only fields confirmed against ProjectionLab 4.6.0 are listed; fields known
 * from names alone are left out entirely.
 */
export const DATA_MODEL_PROJECTIONLAB_VERSION = "4.6.0";

export type DataModelEvidence = "observed" | "ui-label";

export interface DataModelField {
  description: string;
  /** Scale for numeric fields, e.g. "percentage points" or "decimal fraction". */
  units?: string;
  /** Complete set of values an enum field accepts. */
  allowedValues?: readonly string[];
  /** Which other field must be set for this field to matter. */
  enabledBy?: string;
  note?: string;
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

function timingFields(prefix: string): Record<string, DataModelField> {
  return {
    [`${prefix}.type`]: {
      description: `Kind of the ${prefix} reference: a fixed date, a keyword, or a milestone.`,
      allowedValues: ["date", "keyword", "milestone"],
      evidence: "ui-label",
    },
    [`${prefix}.value`]: {
      description: `Target of the ${prefix} reference: "YYYY-MM-DD" when type is "date", a keyword such as "now", "beforeCurrentYear", "endOfPlan", or "never" when type is "keyword", or a milestone ID when type is "milestone".`,
      evidence: "ui-label",
    },
    [`${prefix}.modifier`]: {
      description: `Offset applied to a milestone ${prefix} reference.`,
      note: '"include" means the milestone year itself; an integer means that many years after it.',
      evidence: "ui-label",
    },
  };
}

const EVENT_IDENTITY: Record<string, DataModelField> = {
  name: { description: "Display label of the event.", evidence: "ui-label" },
  hidden: {
    description: "When true, the event is hidden from the timeline.",
    evidence: "ui-label",
  },
  owner: {
    description: "Which household member the event belongs to.",
    allowedValues: ["me", "spouse", "joint"],
    evidence: "ui-label",
  },
};

const EVENT_MONEY: Record<string, DataModelField> = {
  amount: {
    description: "Amount of the event in the plan's base currency.",
    units: DOLLARS,
    evidence: "ui-label",
  },
  amountType: {
    description:
      "Currency basis of the amount: real purchasing power, nominal dollars, or grown from today.",
    allowedValues: ["today$", "$", "grow$"],
    evidence: "ui-label",
    note: '"today$" keeps pace with inflation; "$" is a nominal figure.',
  },
  frequency: {
    description: "How often a recurring event repeats.",
    allowedValues: ["yearly", "monthly", "once"],
    evidence: "ui-label",
  },
  repeat: {
    description: "When true, the event repeats on a cadence instead of occurring once.",
    evidence: "ui-label",
  },
  "yearlyChange.type": {
    description: "How the amount changes each year.",
    allowedValues: [
      "none",
      "match-inflation",
      "fixed-rate",
      "fixed-amount",
      "curve",
    ],
    evidence: "ui-label",
  },
  "yearlyChange.amount": {
    description: "Magnitude of the yearly change.",
    note: 'Percentage points when yearlyChange.type is "fixed-rate"; a dollar amount when it is "fixed-amount".',
    evidence: "ui-label",
  },
  "yearlyChange.amountType": {
    description: "Currency basis of yearlyChange.amount.",
    allowedValues: ["today$", "$"],
    evidence: "ui-label",
  },
  "yearlyChange.limitEnabled": {
    description: "When true, caps the yearly change at yearlyChange.limit.",
    evidence: "ui-label",
  },
  "yearlyChange.limit": {
    description: "Cap applied when yearlyChange.limitEnabled is true.",
    units: PCT,
    evidence: "ui-label",
  },
};

function sharedEventFields(): Record<string, DataModelField> {
  return {
    ...EVENT_IDENTITY,
    ...EVENT_MONEY,
    ...timingFields("start"),
    ...timingFields("end"),
  };
}

const EARLY_WITHDRAWAL_FIELDS: Record<string, DataModelField> = {
  hasEWPenalty: {
    description: "When true, early withdrawals before EWAge incur a penalty.",
    evidence: "observed",
  },
  EWPenaltyRate: {
    description: "Penalty charged on early withdrawals.",
    units: PCT,
    enabledBy: "hasEWPenalty",
    note: "Commonly 10 for retirement accounts and 20 for an HSA.",
    evidence: "observed",
  },
  EWAge: {
    description: "Age after which the early withdrawal penalty no longer applies.",
    units: "age",
    enabledBy: "hasEWPenalty",
    evidence: "observed",
  },
};

export const DATA_MODEL_GROUPS: readonly DataModelGroup[] = [
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
  {
    scope: "income",
    title: "Income events",
    fields: {
      ...sharedEventFields(),
      type: {
        description: "Kind of income event.",
        allowedValues: [
          "salary",
          "hourly",
          "rsu",
          "inheritance",
          "side-hustle",
          "tax-credit",
          "tax-deduction",
          "pension",
          "social-security",
          "old-age-security",
          "canada-pension-plan",
          "other",
        ],
        evidence: "ui-label",
      },
      taxCharacter: {
        description: "How the income is characterized for tax.",
        allowedValues: ["auto", "ordinary", "capital-gains"],
        evidence: "ui-label",
      },
      withholdingMode: {
        description: "Whether tax withholding is estimated automatically or customized.",
        allowedValues: ["auto", "custom"],
        evidence: "ui-label",
      },
      taxExempt: {
        description: "When true, the income is exempt from tax.",
        evidence: "ui-label",
      },
      goPartTime: {
        description: "When true, models a phased transition to part-time work.",
        evidence: "ui-label",
      },
      partTimeRate: {
        description: "Share of full salary earned while part-time.",
        units: PCT,
        enabledBy: "goPartTime",
        note: "50 means half salary.",
        evidence: "ui-label",
      },
      hasPension: {
        description: "When true, employer-sponsored defined-benefit pension accrual is modeled.",
        evidence: "ui-label",
      },
      pensionContributionType: {
        description: "Basis of the pension contribution.",
        allowedValues: ["%", "$"],
        enabledBy: "hasPension",
        evidence: "ui-label",
      },
      pensionPayoutType: {
        description: "Basis of the pension payout.",
        allowedValues: ["fap", "average", "today$", "$"],
        enabledBy: "hasPension",
        evidence: "ui-label",
        note: '"fap" is a percentage of final pay; "average" a percentage of career average pay.',
      },
      pensionPayoutRate: {
        description: "Pension payout as a percentage figure.",
        units: PCT,
        enabledBy: "hasPension",
        evidence: "ui-label",
      },
      hoursPerWeek: {
        description: "Hours worked per week (hourly wage events).",
        units: "count",
        evidence: "ui-label",
      },
      estimateIncome: {
        description:
          "When true, the Social Security benefit is estimated from earnings history; when false, amount is entered manually.",
        evidence: "observed",
      },
      primaryInsuranceAmount: {
        description:
          "Monthly benefit at full retirement age used by the automatic estimate.",
        units: DOLLARS,
        enabledBy: "estimateIncome",
        evidence: "observed",
      },
      expectedPercent: {
        description: "Share of the statutory benefit expected to be paid.",
        units: PCT,
        enabledBy: "estimateIncome",
        note: "100 assumes full benefits; a lower figure models trust fund exhaustion.",
        evidence: "observed",
      },
      refundable: {
        description: "When true, a tax credit is refundable beyond the tax owed.",
        evidence: "ui-label",
      },
    },
  },
  {
    scope: "expenses",
    title: "Expense events",
    fields: {
      ...sharedEventFields(),
      type: {
        description: "Kind of expense event.",
        allowedValues: [
          "living-expenses",
          "rent",
          "debt",
          "dependent-support",
          "education",
          "health-care",
          "medicare",
          "vacation",
          "wedding",
          "charity",
          "travel",
          "medical",
          "emergency",
          "other",
        ],
        evidence: "ui-label",
      },
      spendingType: {
        description:
          "Whether the expense is essential or discretionary spending.",
        allowedValues: ["essential", "discretionary"],
        evidence: "observed",
      },
      healthcareType: {
        description: "How health insurance premiums are modeled.",
        allowedValues: ["standard", "out-of-pocket", "aca", "employer"],
        evidence: "observed",
      },
      supplementalType: {
        description: "Medicare supplemental coverage.",
        allowedValues: ["none", "medigap", "advantage"],
        evidence: "observed",
      },
      partAPremium: {
        description: "Medicare Part A monthly premium.",
        units: DOLLARS,
        evidence: "observed",
      },
      partBPremium: {
        description: "Medicare Part B monthly premium.",
        units: DOLLARS,
        evidence: "observed",
      },
      partDPremium: {
        description: "Medicare Part D monthly premium.",
        units: DOLLARS,
        evidence: "observed",
      },
      supplementalPremium: {
        description: "Medicare supplemental plan monthly premium.",
        units: DOLLARS,
        enabledBy: 'supplementalType "medigap" or "advantage"',
        evidence: "observed",
      },
      healthcareInflationModifier: {
        description: "Medical cost inflation above general inflation.",
        units: PCT,
        evidence: "observed",
      },
      fundWithAccounts: {
        description:
          "Account IDs prioritized to pay this expense, such as an HSA for health care or a 529 for education.",
        evidence: "ui-label",
      },
      deductFromIncomeId: {
        description:
          "Income event ID whose pay models pre-tax payroll deductions for this expense.",
        evidence: "ui-label",
      },
      monthlyPayment: {
        description: "Scheduled monthly payment for a debt expense.",
        units: DOLLARS,
        evidence: "ui-label",
      },
      monthlyPaymentType: {
        description: "Currency basis of monthlyPayment.",
        allowedValues: ["today$", "$"],
        evidence: "ui-label",
      },
      interestRate: {
        description: "Annual percentage rate of a debt expense.",
        units: PCT,
        evidence: "ui-label",
      },
      interestType: {
        description: "How interest accrues on a debt expense.",
        allowedValues: ["simple", "compound"],
        evidence: "ui-label",
      },
      compounding: {
        description: "Frequency at which interest compounds.",
        allowedValues: ["monthly", "yearly"],
        enabledBy: 'interestType "compound"',
        evidence: "ui-label",
      },
      hasForgiveness: {
        description: "When true, the debt is forgiven at forgiveAt instead of amortizing to zero.",
        evidence: "ui-label",
      },
      switchToMarried: {
        description:
          "When true, the wedding switches tax filing status to married filing jointly at the wedding date.",
        evidence: "ui-label",
      },
      donationType: {
        description: "Whether a charitable donation is cash or appreciated assets.",
        allowedValues: ["cash", "appreciated-assets"],
        evidence: "ui-label",
      },
      taxDeductible: {
        description: "When true, the expense reduces taxable income.",
        evidence: "observed",
      },
      itemized: {
        description:
          "When true, the deduction counts as an itemized deduction rather than above the line.",
        enabledBy: "taxDeductible",
        evidence: "observed",
      },
    },
  },
  {
    scope: "accounts",
    title: "Plan accounts",
    fields: {
      name: { description: "Display label of the account.", evidence: "ui-label" },
      owner: {
        description: "Which household member owns the account.",
        allowedValues: ["me", "spouse", "joint"],
        evidence: "ui-label",
      },
      type: {
        description: "Account type.",
        evidence: "ui-label",
        note: 'US types include "taxable", "crypto", "401k", "roth-401k", "457b", "roth-457b", "401a", "ira", "roth-ira", "ira:inherited", "roth-ira:inherited", "hsa", "529"; other countries add types such as "stock-isa", "uk-pension", "sipp", "tfsa", "rrsp", "superannuation", "kh".',
      },
      balance: {
        description: "Current balance of the account.",
        units: DOLLARS,
        evidence: "observed",
      },
      costBasis: {
        description: "Unadjusted tax basis tracked for capital gains on taxable accounts.",
        units: DOLLARS,
        evidence: "observed",
      },
      investmentGrowthType: {
        description: "How the account's growth rate is determined.",
        allowedValues: ["plan", "fixed", "none"],
        evidence: "observed",
        note: '"plan" follows the global rate; a custom fixed rate is stored as "fixed", not "custom".',
      },
      investmentGrowthRate: {
        description: "Custom annual growth rate for the account.",
        units: PCT,
        enabledBy: 'investmentGrowthType "fixed"',
        evidence: "observed",
      },
      dividendType: {
        description: "How the account's dividend yield is determined.",
        evidence: "ui-label",
        note: 'Observed values include "plan" and "none".',
      },
      dividendRate: {
        description: "Custom annual dividend yield for the account.",
        units: PCT,
        evidence: "observed",
      },
      ...EARLY_WITHDRAWAL_FIELDS,
      yearlyFee: {
        description: "Recurring account fee.",
        note: 'Interpreted per yearlyFeeType: a percentage, a percentage of earnings, or a dollar amount.',
        evidence: "ui-label",
      },
      yearlyFeeType: {
        description: "Basis of yearlyFee.",
        allowedValues: ["%", "%-earnings", "today$", "$"],
        evidence: "ui-label",
      },
      liquid: {
        description: "Whether the account counts toward liquid net worth.",
        evidence: "observed",
        note: 'true, false, or "EWAge" to count only once the penalty age has passed.',
      },
      withdraw: {
        description: "Whether the account is eligible for automatic drawdown liquidation.",
        evidence: "observed",
        note: 'true, false, "EWAge", or "after" (see withdrawAge).',
      },
      withdrawAge: {
        description: "Timing reference after which the account becomes eligible for drawdown.",
        enabledBy: 'withdraw "after"',
        evidence: "observed",
      },
      rmdType: {
        description: "Statutory required minimum distribution regime.",
        allowedValues: ["us", "none"],
        evidence: "ui-label",
      },
    },
  },
  {
    scope: "assets",
    title: "Assets (plan asset events and Current Finances real assets)",
    fields: {
      ...EVENT_IDENTITY,
      type: {
        description: "Kind of asset.",
        evidence: "ui-label",
        note: 'Known kinds: "real-estate", "land", "car", "motorcycle", "boat", "jewelry", "precious-metals", "furniture", "instrument", "machinery", "other".',
      },
      subtype: {
        description: "Sub-kind for real property.",
        evidence: "ui-label",
        note: '"rental" for rental property; "rental-building" for commercial property.',
      },
      initialValue: {
        description: "Acquisition purchase price.",
        units: DOLLARS,
        evidence: "observed",
      },
      initialValueType: {
        description: "Currency basis of initialValue.",
        evidence: "observed",
      },
      amount: {
        description: "Current market value of the asset.",
        units: DOLLARS,
        evidence: "observed",
        note: "Counts as an asset on the balance sheet.",
      },
      amountType: {
        description: "Currency basis of amount.",
        evidence: "observed",
      },
      paymentMethod: {
        description: "Whether the asset was bought outright or financed.",
        allowedValues: ["pay-in-full", "financed"],
        evidence: "observed",
      },
      balance: {
        description: "Outstanding loan principal on the asset.",
        units: DOLLARS,
        enabledBy: 'paymentMethod "financed"',
        evidence: "observed",
        note: "Counts as a liability on the balance sheet; 0 when paid in full.",
      },
      balanceType: {
        description: "Currency basis of balance.",
        evidence: "observed",
      },
      downPayment: {
        description: "Cash down payment at acquisition.",
        units: DOLLARS,
        enabledBy: 'paymentMethod "financed"',
        evidence: "observed",
      },
      downPaymentType: {
        description: "Currency basis of downPayment.",
        evidence: "observed",
      },
      monthlyPayment: {
        description: "Scheduled monthly financing payment.",
        units: DOLLARS,
        enabledBy: 'paymentMethod "financed"',
        evidence: "observed",
      },
      monthlyPaymentType: {
        description: "Currency basis of monthlyPayment.",
        evidence: "observed",
      },
      interestRate: {
        description: "Annual percentage rate of the asset's loan.",
        units: PCT,
        enabledBy: 'paymentMethod "financed"',
        evidence: "observed",
      },
      interestType: {
        description: "How interest accrues on the asset's loan.",
        allowedValues: ["simple", "compound"],
        evidence: "observed",
      },
      compounding: {
        description: "Frequency at which loan interest compounds.",
        allowedValues: ["monthly", "yearly"],
        enabledBy: 'interestType "compound"',
        evidence: "observed",
      },
      assessedValue: {
        description: "Assessed value used for property tax.",
        units: DOLLARS,
        evidence: "observed",
      },
      taxRate: {
        description: "Annual property tax figure.",
        note: "A dollar amount or a percentage of assessedValue, per taxRateType.",
        evidence: "observed",
      },
      taxRateType: {
        description: "Basis of taxRate.",
        allowedValues: ["today$", "%"],
        evidence: "observed",
        note: '"%" is a percentage of assessedValue; "today$" is a dollar amount.',
      },
      maintenanceRate: {
        description: "Annual maintenance cost.",
        note: "A dollar amount or a percentage of market value, per maintenanceRateType.",
        evidence: "observed",
      },
      maintenanceRateType: {
        description: "Basis of maintenanceRate.",
        allowedValues: ["today$", "%"],
        evidence: "observed",
      },
      insuranceRate: {
        description: "Annual insurance cost.",
        note: "A dollar amount or a percentage of market value, per insuranceRateType.",
        evidence: "observed",
      },
      insuranceRateType: {
        description: "Basis of insuranceRate.",
        allowedValues: ["today$", "%"],
        evidence: "observed",
      },
      brokersFee: {
        description: "Broker or transaction fee charged at sale.",
        units: PCT,
        evidence: "observed",
      },
      "yearlyChange.type": {
        description: "How the asset's value moves each year.",
        allowedValues: ["inflation+", "inflation-", "depreciate", "appreciate"],
        evidence: "observed",
      },
      "yearlyChange.amount": {
        description: "Rate of the asset's yearly value change.",
        units: PCT,
        evidence: "observed",
      },
      excludeLoanFromLNW: {
        description: "When true, the asset's loan balance is excluded from liquid net worth.",
        evidence: "observed",
      },
      sellIfNeeded: {
        description: "When true, the asset is liquidated automatically if the portfolio depletes.",
        evidence: "observed",
      },
      cancelRent: {
        description: "When true, acquiring the asset cancels the rent expense.",
        evidence: "observed",
      },
      modifyAccount: {
        description: "Destination account for the net sale proceeds.",
        evidence: "observed",
        note: "false, true, or an account ID.",
      },
      repeat: {
        description: "When true, the asset is re-acquired on a cadence.",
        evidence: "observed",
      },
      repeatInterval: {
        description: "Years between replacements of the asset.",
        units: YEARS,
        enabledBy: "repeat",
        evidence: "observed",
      },
      repeatIntervalType: {
        description: "Cadence mode for replacements.",
        allowedValues: ["every"],
        evidence: "observed",
      },
      generateIncome: {
        description: "When true, the property generates modeled rental income.",
        evidence: "ui-label",
      },
      incomeRate: {
        description: "Gross rental yield of the property.",
        units: PCT,
        enabledBy: "generateIncome",
        evidence: "ui-label",
      },
      managementRate: {
        description: "Property management fee.",
        units: PCT,
        enabledBy: "generateIncome",
        evidence: "ui-label",
      },
      monthlyHOA: {
        description: "Monthly homeowners association dues.",
        units: DOLLARS,
        enabledBy: "generateIncome",
        evidence: "ui-label",
      },
      estimateRentalDeductions: {
        description: "When true, deducts depreciation, interest, and taxes from rental income.",
        enabledBy: "generateIncome",
        evidence: "ui-label",
      },
      estimateQBI: {
        description: "When true, models the qualified business income deduction on rental income.",
        enabledBy: "generateIncome",
        evidence: "ui-label",
      },
      ...timingFields("start"),
      ...timingFields("end"),
    },
  },
  {
    scope: "milestones",
    title: "Milestones",
    fields: {
      name: { description: "Display label of the milestone.", evidence: "observed" },
      id: {
        description: "Built-in key or generated ID of the milestone.",
        evidence: "observed",
        note: 'Built-ins: "retirement", "spouseRetirement", "lifeExpectancy", "spouseLifeExpectancy", "fi"; custom milestones get a generated ID.',
      },
      removable: {
        description: "True for user-created milestones; omitted for built-ins.",
        evidence: "observed",
      },
      "criteria.*.type": {
        description: "Kind of criterion that positions the milestone.",
        allowedValues: ["date", "year", "milestone", "netWorth", "totalDebt", "age"],
        evidence: "observed",
      },
      "criteria.*.value": {
        description: "Target of the criterion.",
        evidence: "observed",
        note: 'A "YYYY-MM-01" date for "date" and "year" types; a milestone ID for the "milestone" type; a numeric threshold for "netWorth" and "totalDebt".',
      },
      "criteria.*.modifier": {
        description: "Offset applied to a milestone criterion.",
        evidence: "observed",
        note: '"include" is the milestone year itself; an integer is that many years after it.',
      },
      "criteria.*.operator": {
        description: "Comparison for a netWorth or totalDebt criterion.",
        evidence: "observed",
        note: 'Observed values include "==" and ">=".',
      },
      "criteria.*.valueType": {
        description: "Basis of a numeric criterion value.",
        evidence: "observed",
        note: '"spending" expresses the value as a multiple of annual spending; "$" as dollars.',
      },
      "criteria.*.range": {
        description: "Tolerance band around a netWorth criterion value.",
        units: "count",
        evidence: "observed",
      },
      "criteria.*.age": {
        description: "Age at which an age criterion fires.",
        units: "age",
        evidence: "observed",
      },
      "criteria.*.householdMemberId": {
        description: "Whose age an age criterion tracks.",
        allowedValues: ["me", "spouse"],
        evidence: "observed",
      },
    },
  },
  {
    scope: "priorities",
    title: "Priorities (cash flow routing)",
    fields: {
      name: { description: "Display label of the cash flow.", evidence: "observed" },
      title: {
        description: "Group header the flow is listed under.",
        evidence: "observed",
      },
      type: {
        description: "Target account or priority type of the flow.",
        evidence: "observed",
        note: 'Examples: "taxable", "ira", "roth-ira", "401k", "hsa", "savings", "emergency-fund", "debt", "asset", "transfer".',
      },
      goalIntent: {
        description: "Whether the flow invests surplus cash or transfers between accounts.",
        allowedValues: ["invest", "transfer"],
        evidence: "observed",
      },
      accountId: {
        description: "Destination account ID the flow routes to.",
        evidence: "observed",
      },
      desiredContribution: {
        description: "How much the flow receives from surplus cash flow.",
        allowedValues: ["max", "fixed"],
        evidence: "observed",
        note: '"max" routes all remaining surplus; "fixed" takes amount.',
      },
      amount: {
        description: "Fixed contribution taken when desiredContribution is \"fixed\".",
        units: DOLLARS,
        evidence: "observed",
      },
      amountType: {
        description: "Currency basis of amount.",
        evidence: "observed",
      },
      frequency: {
        description: "How often the flow is funded.",
        evidence: "observed",
        note: 'Examples: "yearly", "monthly".',
      },
      owner: {
        description: "Household member the flow belongs to.",
        allowedValues: ["me", "spouse", "joint"],
        evidence: "ui-label",
      },
      ...timingFields("start"),
      ...timingFields("end"),
    },
  },
  {
    scope: "savingsAccounts",
    title: "Current Finances: savings accounts",
    fields: {
      name: { description: "Display label of the account.", evidence: "ui-label" },
      balance: {
        description: "Cash balance of the account.",
        units: DOLLARS,
        evidence: "ui-label",
      },
      interestRate: {
        description: "Annual percentage yield paid on the balance.",
        units: PCT,
        evidence: "ui-label",
      },
      owner: {
        description: "Which household member owns the account.",
        allowedValues: ["me", "spouse", "joint"],
        evidence: "ui-label",
      },
    },
  },
  {
    scope: "investmentAccounts",
    title: "Current Finances: investment accounts",
    fields: {
      name: { description: "Display label of the account.", evidence: "ui-label" },
      type: {
        description: "Account type.",
        evidence: "ui-label",
        note: 'For example "taxable", "ira", "401k", "roth-ira", "hsa".',
      },
      balance: {
        description: "Current balance of the account.",
        units: DOLLARS,
        evidence: "ui-label",
      },
      costBasis: {
        description:
          "Unadjusted tax basis, required for taxable brokerage accounts.",
        units: DOLLARS,
        evidence: "ui-label",
      },
      owner: {
        description: "Which household member owns the account.",
        allowedValues: ["me", "spouse", "joint"],
        evidence: "ui-label",
      },
      ...EARLY_WITHDRAWAL_FIELDS,
      rmdType: {
        description: "Statutory required minimum distribution regime.",
        allowedValues: ["us", "none"],
        evidence: "ui-label",
      },
    },
  },
  {
    scope: "debts",
    title: "Current Finances: unsecured debts",
    fields: {
      name: { description: "Display label of the debt.", evidence: "ui-label" },
      balance: {
        description: "Outstanding principal of the debt.",
        units: DOLLARS,
        evidence: "ui-label",
      },
      interestRate: {
        description: "Annual percentage rate of the debt.",
        units: PCT,
        evidence: "ui-label",
      },
      monthlyPayment: {
        description: "Minimum monthly payment.",
        units: DOLLARS,
        evidence: "ui-label",
      },
      owner: {
        description: "Which household member owes the debt.",
        allowedValues: ["me", "spouse", "joint"],
        evidence: "ui-label",
      },
    },
  },
];

interface CompiledEntry {
  pattern: string;
  segments: string[];
  field: DataModelField;
}

const compiledByScope = new Map<string, CompiledEntry[]>();
for (const group of DATA_MODEL_GROUPS) {
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

export interface DataModelAnnotation {
  description?: string;
  units?: string;
  allowedValues?: readonly string[];
}

/**
 * Copy listed values, attaching description, units, and allowedValues for
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
    if (field.allowedValues) annotated.allowedValues = field.allowedValues;
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
  if (!field?.allowedValues || field.evidence !== "observed") return undefined;
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
