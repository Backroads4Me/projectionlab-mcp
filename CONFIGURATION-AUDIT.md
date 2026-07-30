# ProjectionLab Configuration Support Audit

This inventory maps plan configuration surfaces in ProjectionLab to the public
MCP interface. ProjectionLab renders fields conditionally based on plan data,
country, account type, subscription, and feature availability, so exported
field paths are the authoritative identifiers for the connected plan.

## Evidence

- Repository tool schemas and safety flows establish current MCP behavior.
- Exported plan structure establishes which settings the Plugin API exposes.
- ProjectionLab's current help center establishes UI terminology and behavior:
  [plan creation](https://projectionlab.com/help/create-new-plan),
  [income forms](https://projectionlab.com/help/add-income-to-your-plan),
  [tax withholding](https://projectionlab.com/help/account-type-tax-settings),
  [advanced rate schedules](https://projectionlab.com/help/model-inflation-spike),
  [flex spending](https://projectionlab.com/help/flex-spending), and
  [withdrawal strategy mode](https://projectionlab.com/help/withdrawal-strategy-mode).
- ProjectionLab's
  [v4.6 release notes](https://projectionlab.com/blog/whats-new-v460)
  establish the current Optimize surfaces for tax strategy, Roth conversions,
  drawdown, gain harvesting, and flexible spending.
- Live verification uses only the authenticated plan named `codex`. The audit
  navigates and inspects controls. Temporary rate-mode inspection is restored
  to Fixed; no plan event or Current Finances item is created.

## Live `codex` UI inventory

The live UI establishes the following user-facing groups. Values and personal
plan details are omitted because the purpose of the audit is configuration
coverage, not financial analysis.

| UI area | Visible configuration groups | MCP coverage |
|---|---|---|
| Settings > Milestones | Existing milestone name; at-date, at-year, or relative-to-milestone timing; offset. The Add Milestone dialog offers Custom Milestone, Move, Financial Independence, FIRE, LeanFIRE, FatFIRE, CoastFIRE, Debt Free, Start School, Graduate, Gap Year, New Job, Get Married, and Kid templates. | Existing event fields are discoverable and patchable. Template-backed creation, removal, and reordering need dedicated operations. |
| Settings > Rates | Fixed, Historical, and Advanced modes; inflation and benefit COLA; stock growth and dividend yield; bond growth and yield. Historical mode includes a sequence starting year plus default/custom inflation, stock, and bond groups. Each Advanced rate opens a control-point editor: the first and last simulation years are fixed endpoints, intermediate years are editable, and ProjectionLab interpolates between points. A schedule can specify every year or use sparse non-linear points. This also models a changing portfolio mix by supplying the blended return produced by that mix in each year. | `variables.assumptionsMode` selects the model. Exported `*Custom` sequences such as `inflationCustom`, `investmentReturnCustom`, `dividendRateCustom`, `bondInvestmentReturnCustom`, and `bondDividendRateCustom` expose both the complete ordered array and indexed fields for each existing control point. UI choices, ranges, and units remain ProjectionLab-defined. |
| Settings > Dividends | Qualified/ordinary dividend composition; reinvestment mode; account overrides | Exported `variables.dividendSettings` paths are discoverable and patchable. Account overrides may live on account events. |
| Settings > Bonds | Allocation mode and target; account-location priority; municipal, government, and other income composition | Exported `variables.bondSettings` paths and ordered arrays are discoverable and patchable. |
| Settings > Tax | Estimation mode and jurisdiction; filing status; withholding for tax-deferred withdrawals, taxable withdrawals, and conversions; tax-law expiration assumptions; income-tax and capital-gains modifiers | Exported `variables` paths are discoverable and patchable. Country-specific choices and restore-default actions are not modeled. |
| Settings > Metrics | Global Effective Tax Rate definitions; global Spending definitions; plan-specific Net Legacy assumptions | Exported plan estate paths are discrete. Global metric definitions are outside the supported plan sections and remain read only through broader exports. |
| Settings > Other Settings | Global year alignment plus an optional per-plan override | The UI is inventoried, but the plan override's exported location and restore semantics require validation before targeted mutation. |
| Plan Notes | Free-form plan assumptions, scenario, and purpose | Visible in the UI but not part of the supported settings sections. |
| Textbook Withdrawals | Enablement plus strategy-specific withdrawal settings | Exported `withdrawalStrategy` paths are discoverable and patchable. |
| Chance of Success > Data Sources | Stock growth, stock dividends, and inflation distributions with means and standard deviations; bond return source | Exported `montecarlo` paths are discoverable and patchable. |
| Chance of Success > Methodology | Historical sampling; number of trials; worker threads; optional fixed random seed | Exported `montecarlo` paths are discoverable and patchable. Running the simulation remains UI-only. |
| Chance of Success > Metrics | Net worth, liquid net worth, expense/spending variants, taxes, rates, withdrawals, and income variants | The selected metric array is patchable when exported. Computed results are not exposed. |
| Chance of Success > Outcome Categories | Names and thresholds for three success and three failure categories | Category objects are patchable when present in the exported `montecarlo` section. |
| Chance of Success > Success Rates | Names and percentage bands for six success-rate levels | Band objects are patchable when present in the exported `montecarlo` section. |
| Optimize > Tax Strategy | Marginal bracket target; capital-gains bracket; NIIT, IRMAA, and ACA constraints; optional time range | Exported `variables.taxStrategy` paths are discoverable and patchable. |
| Optimize > Flexible Spending | Off/flexible mode and portfolio-responsive discretionary-spending rules | Exported `variables.flexSpending` paths are patchable; expense-level flexibility uses event paths. |
| Optimize > Roth Conversions | Enablement; shared tax target; source accounts; time range; optional annual cap | Exported `variables.rothConversionStrategy` paths are discoverable and patchable. |
| Optimize > Drawdown | Withdrawal shielding; time range; ordered drawdown categories; Textbook Withdrawals link | Exported drawdown settings and ordered arrays are discoverable and patchable. |
| Optimize > Gain Harvesting | Enablement; shared capital-gains target; source accounts; time range; optional annual cap | Exported `variables.gainHarvestingStrategy` paths are discoverable and patchable. |
| Current Finances > Savings and Investments | Balance and owner; subtype details such as Roth contribution basis and taxable cost basis; add-item actions | Existing exported records are targetable by exact ID and expose typed paths for safe top-level or nested patches. Creation remains unavailable. |
| Current Finances > Real Assets | Purchase price, current value, owner, ownership/debt status; add-asset action | Existing exported asset records are targetable by exact ID and patchable. Creating assets or modeling a financed status requires subtype-aware creation support. |
| Current Finances > Unsecured Debts | Existing debt records plus add-debt action | Existing exported debts are targetable by exact ID and patchable. Creation remains unavailable. |
| Current Finances > About You | Individual/couple composition; person names and birth month/year; country/region; currency and locale | Visible through broader Current Finances/export data where represented, but not handled by the account patch tool. Targeted household/profile mutation remains unavailable. |

## Support levels

- **Discrete**: a targeted read and patch operation preserves sibling values.
- **Generic**: raw section/event data is available, but callers need data-model
  knowledge.
- **Read only**: data is visible but no targeted mutation exists.
- **Unavailable**: the Plugin API or MCP interface does not expose the action.

## UI-to-MCP inventory

| ProjectionLab UI surface | Plugin API representation | MCP read support | MCP mutation support | Level and notes |
|---|---|---|---|---|
| Plan list and selected plan | Top-level `plans[]`; plan `id`, `name`, `active`, and metadata | `projectionlab_describe_schema`, `projectionlab_get_plan` | Whole-plan restore tools only | Read only. No create, clone, rename, activate, reorder, or delete tool. |
| Milestones | `plan.milestones[]` with criteria and presentation fields | Event filtering and typed path listing | Top-level or nested path patch; whole-section replacement | Discrete for existing paths. Allowed criteria variants are not described. |
| Income forms | `plan.income.events[]`; subtype-dependent amount, timing, recurrence, tax, part-time, pension, and destination fields | Event filtering and typed path listing | Top-level or nested path patch; whole-section replacement | Discrete for existing paths. The MCP does not publish subtype schemas or UI enum choices. |
| Accounts in a plan | `plan.accounts.events[]`; subtype-dependent contribution, conversion, liquidity, tax, and allocation fields | Event filtering and typed path listing | Top-level or nested path patch; whole-section replacement | Discrete for existing paths, including nested Roth and account settings. Semantic constraints remain ProjectionLab-defined. |
| Flows | `plan.priorities.events[]` | Event filtering and typed path listing | Top-level or nested path patch; whole-section replacement | Discrete for existing paths. The stored section retains the `priorities` identifier while the UI calls the surface Flows. Reordering requires full-section replacement. |
| Expenses | `plan.expenses.events[]`; subtype-dependent amount, timing, recurrence, tax, and flexibility fields | Event filtering and typed path listing | Top-level or nested path patch; whole-section replacement | Discrete for existing paths, including nested flexibility fields. Subtype schemas are absent. |
| Real assets | `plan.assets.events[]`; subtype-dependent purchase, sale, financing, maintenance, income, and tax fields | Event filtering and typed path listing | Top-level or nested path patch; whole-section replacement | Discrete for existing paths. Semantic field validation remains unavailable. |
| Projection basis and currency display | `variables.projectFrom`, `startDate`, `startYear`, `loopYear`, `showFutureDollars` | `projectionlab_get_plan_settings` | `projectionlab_update_plan_settings` | Discrete for paths present in the connected plan. |
| General assumptions | `variables.assumptionsMode`; fixed/modifier fields and ordered `inflationCustom`, `investmentReturnCustom`, `dividendRateCustom`, `bondInvestmentReturnCustom`, and `bondDividendRateCustom` schedules | `projectionlab_get_plan_settings` | `projectionlab_update_plan_settings` | Discrete. Live verification confirms year/rate control points for all five schedules and a populated multi-point stock-growth sequence. A caller can patch one existing point by indexed path or replace the complete array when adding, removing, or reordering points. |
| Tax estimation and filing | `estimateTaxes`, `filingStatus`, `incomeTax*`, `capGains*`, `dividendTax*`, `bondDividendTax*`, `localIncomeTaxRate` | `projectionlab_get_plan_settings` | `projectionlab_update_plan_settings` | Discrete for fields present in the plan. Country-specific meaning and UI choices remain ProjectionLab-defined. |
| Other tax controls | `wealthTax*`, `ftt*`, `tcjaReversion`, `bbbSaltReversion`, `bbbSeniorReversion`, `benefitColaModifier`, `irmaa`, `medicare`, `withholding` | `projectionlab_get_plan_settings` | `projectionlab_update_plan_settings` | Discrete. Some values are nested objects and some appear only for applicable jurisdictions or features. |
| Drawdown and tax optimization | `drawdownOrder`, `drawdownBlendingStrategy`, `taxStrategy`, `rothConversionStrategy`, `gainHarvestingStrategy` | `projectionlab_get_plan_settings` | `projectionlab_update_plan_settings` | Discrete when the connected plan exports the path. The MCP preserves nested siblings when patching a leaf. |
| Flexible spending | `variables.flexSpending`; expense-event flexibility fields | Plan settings and event reads | Path patch for plan rules; event patch for an expense | Generic-to-discrete. Rule arrays can be replaced atomically; individual expense tagging still depends on event field discovery. |
| Estate planning | `variables.estate` | `projectionlab_get_plan_settings` | `projectionlab_update_plan_settings` | Discrete for exported nested paths. |
| Plan notes | Top-level plan notes field | Full plan/export reads | Snapshot restore only | Read only. A targeted notes operation needs exact field and restore validation. |
| Year alignment | Global account setting plus optional plan override | Full export where present | Snapshot restore only | Read only. The override's plan field needs live export validation. |
| Withdrawal Strategy mode | `withdrawalStrategy.enabled`, `strategy`, `start`, `spendMode`, and strategy-specific objects such as `initial-%`, `fixed-%`, `fixed-amount`, `vpw`, `guyton-klinger`, `kitces-ratchet`, `clyatt-95%`, and `1/N` | `projectionlab_get_plan_settings` | `projectionlab_update_plan_settings` | Discrete. Strategy-specific objects remain present as addressable nested paths when exported. |
| Chance of Success / Monte Carlo configuration | `montecarlo` sampling, trial/worker/seed settings, result metrics, outcome and success-rate categories, and return/inflation distribution parameters | `projectionlab_get_plan_settings` | `projectionlab_update_plan_settings` | Discrete for exported paths. Simulation execution and trial results remain UI-only. |
| Current Finances accounts, debts, and real assets | Top-level `today.investmentAccounts`, `savingsAccounts`, `debts`, and `assets` arrays | `projectionlab_get_current_finances` can return all data, one exact ID, or typed paths for that item | `projectionlab_update_account` supports validated top-level or nested path patches | Discrete for existing fields. Dry-run before/after values are safety diffs, not plan-impact metrics; nested patches preserve siblings; confirmed writes snapshot Current Finances and verify requested paths. Create, delete, and subtype schemas are unavailable. |
| Progress tracking | Top-level `progress` | Full export/resource | Snapshot restore only | Read only. |
| Application/display settings | Top-level `settings` | Full export/resource | Snapshot restore only | Read only. Plan calculation settings belong to plan `variables`; UI presentation settings are not plan configuration. |

## Implemented settings interface

`projectionlab_get_plan_settings` turns the three non-event configuration
sections into a discoverable list:

```json
{
  "section": "variables",
  "settings": [
    {
      "path": "estate.enabled",
      "type": "boolean",
      "value": true
    }
  ]
}
```

`projectionlab_update_plan_settings` accepts one section and a map of those
paths to new values. It:

1. fetches a fresh export and resolves one plan;
2. rejects empty changes, unknown paths, unsafe prototype or secret paths,
   overlapping parent/child changes, and JSON type changes;
3. applies changes immutably while preserving siblings;
4. returns a dry-run diff unless `confirm: true`;
5. snapshots all plans before a confirmed mutation;
6. restores the changed plans through the Plugin API; and
7. re-exports and verifies every requested value.

`PL_READ_ONLY=true` rejects the mutation tool before any snapshot or restore.
Secrets remain server-side, and full exports retain the existing redaction
flow.

## Implemented event-path interface

`projectionlab_get_plan_section` accepts `listPaths: true`. When combined with
`eventIdentifier`, it returns every existing leaf field with its dot path,
current value, and JSON type. Arrays remain intact because their ordering is
meaningful.

`projectionlab_update_plan_event` accepts either:

- `pathChanges`, which applies existing dot paths immutably and preserves
  nested siblings; or
- `patch`, which provides backward-compatible shallow top-level merging.

Path changes reject unknown, unsafe, secret, overlapping, and type-changing
inputs. Confirmed changes use the existing plan snapshot, restore, and fresh
verification flow. A confirmed no-op does not snapshot or send a restore.

## Prioritized remaining gaps

### P0 — Projected outcome calculation and retrieval

Projected ending net worth and Chance of Success are the primary metrics for
judging whether a plan change helps. Current Finances values are inputs, and
mutation before/after values are safety evidence only. The Plugin API export
includes plan definitions and Monte Carlo configuration, but no documented
method to recalculate and retrieve either primary outcome.

Until a stable Plugin API method exists, MCP must not claim impact from a field
diff or current net worth. A safe outcome interface needs to return the exact
plan ID, projected ending net worth, completed Chance of Success percentage,
simulation configuration or run identity, and calculation time. Live testing
must establish recalculation triggers, determinism, stale-result behavior, and
whether a simulation can be cancelled. The UI remains authoritative after a
mutation: re-read the changed input through MCP, then recalculate the plan and
run Chance of Success before comparing outcomes.

### P1 — Event field discovery and semantic validation

Income, expenses, accounts, assets, milestones, and flows contain many
subtype-specific discrete controls. Typed path listing exposes the fields
present on an existing event, but it cannot describe absent optional fields,
allowed enum values, numeric ranges, units, or dependencies. A schema tool
should group events by subtype and add validated semantic metadata. Static
schemas alone are brittle because ProjectionLab changes forms and conditionally
renders fields.

### P1 — Safe event creation, removal, and reordering

The only way to add, remove, or reorder events is
`projectionlab_update_plan_section`, which replaces the complete section.
Dedicated operations should use stable IDs, preview structural diffs, snapshot
plans, and verify both event identity and ordering. Creation also needs either
Plugin API constructors or well-understood subtype defaults. Milestone creation
also needs explicit template semantics for Custom, Move, Financial
Independence, FIRE variants, Debt Free, education, job, marriage, and child
milestones; copying arbitrary UI payloads risks creating incomplete events.

### P1 — Plan metadata and starting conditions

Plan-level fields such as `startingConditionsType` and
`startingConditions` are visible in exports but are not included in
`PLAN_SECTIONS`. Their UI meaning and restore behavior need live validation
before they become mutation targets. Plan notes and the per-plan year-alignment
override have the same boundary. Plan rename, copy, activation, and deletion
also lack targeted Plugin API methods.

### P2 — Global metric definitions

Effective Tax Rate and Spending definitions are configured globally across
plans, while Net Legacy assumptions are plan-specific. The settings tool
intentionally patches only plan sections, so global definitions need a separate
account-settings interface with its own snapshot scope and restore verification.

### P2 — Current Finances creation and subtype schemas

`projectionlab_update_account` safely patches an existing item, but no tools
create or delete accounts, debts, or real assets. These actions need
subtype-specific required fields and reversible API support.
Whole-current-finances restoration is too broad for routine creation.

### P2 — UI enum and range metadata

The export identifies current values and JSON types, not the complete allowed
choices, units, ranges, dependencies, or subscription gates. Live UI inspection
can document the `codex` plan's visible controls, but a durable solution needs
Plugin API schema metadata or a maintained compatibility catalog keyed to
ProjectionLab versions.
