import { exportSections } from "./layout.js";
import {
  applyExistingPathChanges,
  listAddressableValues,
  type AddressableValue,
  type PathValueChange,
} from "./pathPatch.js";
import { NOT_REPORTED, type PlanObj } from "./plans.js";

export const PLAN_SETTING_SECTIONS = [
  "variables",
  "montecarlo",
  "withdrawalStrategy",
] as const;

export type PlanSettingSection = (typeof PLAN_SETTING_SECTIONS)[number];
export type PlanSetting = AddressableValue;
export type PlanSettingChange = PathValueChange;

const ADVANCED_RATE_SCHEDULES = new Set([
  "inflationCustom",
  "investmentReturnCustom",
  "dividendRateCustom",
  "bondInvestmentReturnCustom",
  "bondDividendRateCustom",
]);

export const PLAN_SETTING_CONTEXT = {
  label: "plan setting",
  discoveryTool: "projectionlab_get_plan_settings",
  example: '{ "inflation": 3 }',
} as const;

export function listPlanSettings(
  sectionData: unknown,
  section?: PlanSettingSection,
): PlanSetting[] {
  return listAddressableValues(
    sectionData,
    "",
    section === "variables"
      ? { expandArrayPaths: ADVANCED_RATE_SCHEDULES }
      : {},
  );
}

export function applyPlanSettingChanges(
  sectionData: unknown,
  incoming: Record<string, unknown>,
  section?: PlanSettingSection,
): {
  updated: Record<string, unknown>;
  changes: Record<string, PlanSettingChange>;
} {
  return applyExistingPathChanges(
    sectionData,
    incoming,
    PLAN_SETTING_CONTEXT,
    section,
  );
}

/** Workspace plan settings as a ProjectionLab 5 export holds them. */
export interface PlanSelection {
  activeId: unknown;
  baselineId: unknown;
  alignment: unknown;
  tabs: unknown;
}

/**
 * The workspace-level plan settings of an export
 * (`documents.settings.plan`). A value the export leaves unset or null is
 * NOT_REPORTED; no plan is ever picked as the active or baseline one here.
 */
export function planSelection(raw: unknown): PlanSelection {
  const settings = exportSections(raw).settings;
  const held =
    settings && typeof settings === "object"
      ? (settings as PlanObj).plan
      : undefined;
  const plan: PlanObj =
    held && typeof held === "object" && !Array.isArray(held)
      ? (held as PlanObj)
      : {};
  const reported = <T>(value: T | null | undefined): T | typeof NOT_REPORTED =>
    value === undefined || value === null ? NOT_REPORTED : value;
  return {
    activeId: reported(plan.activeId),
    baselineId: reported(plan.baselineId),
    alignment: reported(plan.alignment),
    tabs: reported(plan.tabs),
  };
}
