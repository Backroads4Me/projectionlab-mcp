import {
  applyExistingPathChanges,
  listAddressableValues,
  pathChangesApplied,
  type AddressableValue,
  type PathValueChange,
} from "./pathPatch.js";

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

const PLAN_SETTING_CONTEXT = {
  label: "plan setting",
  discoveryTool: "projectionlab_get_plan_settings",
  example: '{ "inflation": 0.03 }',
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
): {
  updated: Record<string, unknown>;
  changes: Record<string, PlanSettingChange>;
} {
  return applyExistingPathChanges(
    sectionData,
    incoming,
    PLAN_SETTING_CONTEXT,
  );
}

export function planSettingChangesApplied(
  sectionData: unknown,
  expected: Record<string, PlanSettingChange>,
): boolean {
  return pathChangesApplied(sectionData, expected, PLAN_SETTING_CONTEXT);
}
