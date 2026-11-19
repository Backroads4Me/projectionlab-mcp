import { isDeepStrictEqual } from "node:util";
import {
  UI_LABELS_V5,
  annotateAddressableValues,
  type DataModelAnnotation,
} from "./dataModel.js";
import type { ExportLayout } from "./layout.js";
import {
  PLAN_SETTING_SECTIONS,
  listPlanSettings,
  type PlanSetting,
  type PlanSettingSection,
} from "./planSettings.js";
import type { PlanObj } from "./plans.js";
import { redactSecrets } from "./redact.js";

/** Heading each settings section carries in the report. */
const SECTION_TITLES: Record<PlanSettingSection, string> = {
  variables: "Assumptions, taxes and estate",
  montecarlo: "Chance of Success",
  withdrawalStrategy: "Withdrawal strategy",
};

const OTHER_GROUP = "Other stored settings";

/** Shown for a path one compared plan holds and the other does not. */
const NOT_SET = "not set";

type AnnotatedSetting = PlanSetting & DataModelAnnotation;

interface ReportRow {
  path: string;
  label: string;
  /** The data model's description, shown for a setting with no label. */
  description?: string;
  group: string;
  /** Position of the label in UI_LABELS_V5, which follows the app's layout. */
  order: number;
  values: { present: boolean; value: unknown; units?: string }[];
}

export interface SettingsReportOptions {
  section?: PlanSettingSection;
  /** Two-plan reports only: leave out the rows whose values match. */
  differencesOnly?: boolean;
}

/**
 * The settings of one plan, or of two plans side by side, as a markdown
 * document. Rows are grouped under the ProjectionLab 5 location of their
 * control and named by its on-screen label; settings without a recorded
 * label close each section under their stored path. Arrays (rate schedules,
 * curves) stay whole, one row each.
 */
export function renderSettingsReport(
  plans: readonly PlanObj[],
  layout: ExportLayout,
  options: SettingsReportOptions = {},
): string {
  const compare = plans.length === 2;
  const names = plans.map((plan) => planName(plan));
  const sections = options.section ? [options.section] : PLAN_SETTING_SECTIONS;

  const lines: string[] = [];
  lines.push(
    compare
      ? `# Plan settings: ${names[0]} vs ${names[1]}`
      : `# Plan settings: ${names[0]}`,
    "",
  );

  const bodies: string[][] = [];
  let total = 0;
  let differing = 0;
  for (const section of sections) {
    const rows = sectionRows(plans, section, layout);
    const diffs = rows.filter((row) => rowDiffers(row));
    total += rows.length;
    differing += diffs.length;
    const shown = compare && options.differencesOnly ? diffs : rows;
    bodies.push(renderSection(section, shown, names, compare));
  }

  if (compare) {
    lines.push(
      `${differing} of ${total} settings differ between the two plans.` +
        (options.differencesOnly ? " Only the differing settings are listed." : ""),
      "",
    );
  } else {
    lines.push(`${total} stored settings.`, "");
  }
  lines.push(
    "Each setting is named by its label in ProjectionLab 5 and grouped by where the control is. " +
      `Settings with no recorded label are listed by their stored path, with a description where one is known, under "${OTHER_GROUP}". ` +
      "Values are what the plan stores; a stored value can be one the app ignores in the current mode.",
    "",
  );
  for (const body of bodies) lines.push(...body);
  return lines.join("\n").trimEnd() + "\n";
}

function planName(plan: PlanObj): string {
  return typeof plan.name === "string" && plan.name.length > 0
    ? plan.name
    : String(plan.id ?? "Unnamed plan");
}

function sectionRows(
  plans: readonly PlanObj[],
  section: PlanSettingSection,
  layout: ExportLayout,
): ReportRow[] {
  const labelOrder = Object.keys(UI_LABELS_V5[section] ?? {});
  const rows = new Map<string, ReportRow>();
  plans.forEach((plan, index) => {
    // No section argument, so rate schedules stay whole arrays rather than
    // also listing each control point.
    const settings: AnnotatedSetting[] = annotateAddressableValues(
      section,
      listPlanSettings(redactSecrets(plan[section], { byName: true })),
      layout,
    );
    for (const setting of settings) {
      let row = rows.get(setting.path);
      if (!row) {
        const position = labelOrder.indexOf(setting.path);
        row = {
          path: setting.path,
          label: setting.uiLabel ?? setting.path,
          description: setting.description,
          group: setting.uiLabel && setting.uiLocation ? setting.uiLocation : OTHER_GROUP,
          order: setting.uiLabel && position >= 0 ? position : Number.MAX_SAFE_INTEGER,
          values: plans.map(() => ({ present: false, value: undefined })),
        };
        rows.set(setting.path, row);
      }
      row.values[index] = {
        present: true,
        value: setting.value,
        units: setting.units,
      };
    }
  });
  return [...rows.values()].sort(
    (a, b) => a.order - b.order || a.path.localeCompare(b.path),
  );
}

function rowDiffers(row: ReportRow): boolean {
  if (row.values.length < 2) return false;
  const [a, b] = row.values;
  return a.present !== b.present || !isDeepStrictEqual(a.value, b.value);
}

function renderSection(
  section: PlanSettingSection,
  rows: readonly ReportRow[],
  names: readonly string[],
  compare: boolean,
): string[] {
  const lines = [`## ${SECTION_TITLES[section]} (\`${section}\`)`, ""];
  if (rows.length === 0) {
    lines.push(compare ? "No differing settings." : "No stored settings.", "");
    return lines;
  }

  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const list = groups.get(row.group) ?? [];
    list.push(row);
    groups.set(row.group, list);
  }
  // The catch-all group always closes the section.
  const ordered = [...groups.keys()].filter((group) => group !== OTHER_GROUP);
  if (groups.has(OTHER_GROUP)) ordered.push(OTHER_GROUP);

  for (const group of ordered) {
    lines.push(`### ${escapeHeading(group)}`, "");
    const other = group === OTHER_GROUP;
    if (compare) {
      lines.push(
        `| Setting | ${cell(names[0])} | ${cell(names[1])} | Differs |`,
        "| --- | --- | --- | :---: |",
      );
    } else {
      lines.push("| Setting | Value |", "| --- | --- |");
    }
    for (const row of groups.get(group) ?? []) {
      const setting = other
        ? `\`${cell(row.path)}\`` + (row.description ? `: ${cell(row.description)}` : "")
        : cell(row.label);
      const values = row.values.map((entry) =>
        cell(entry.present ? formatValue(entry.value, entry.units) : NOT_SET),
      );
      lines.push(
        compare
          ? `| ${setting} | ${values[0]} | ${values[1]} | ${rowDiffers(row) ? "**Yes**" : ""} |`
          : `| ${setting} | ${values[0]} |`,
      );
    }
    lines.push("");
  }
  return lines;
}

/** A stored value in the form the app shows it, scaled by its units. */
export function formatValue(value: unknown, units?: string): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return formatNumber(value, units);
  if (typeof value === "string") return value.length > 0 ? value : "(empty)";
  if (Array.isArray(value)) return formatArray(value);
  return JSON.stringify(value);
}

function formatNumber(value: number, units?: string): string {
  if (!Number.isFinite(value)) return String(value);
  switch (units) {
    case "percentage points":
      return `${trim(value)}%`;
    case "decimal fraction":
      return `${trim(value * 100)}%`;
    case "dollars": {
      const sign = value < 0 ? "-" : "";
      const amount = Math.abs(value).toLocaleString("en-US", {
        maximumFractionDigits: 2,
      });
      return `${sign}$${amount}`;
    }
    default:
      return trim(value);
  }
}

/** Rounds away binary floating-point noise such as 0.035 * 100. */
function trim(value: number): string {
  return String(Number(value.toFixed(6)));
}

function formatArray(values: readonly unknown[]): string {
  if (values.length === 0) return "(empty list)";
  return values
    .map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>);
        // A two-field control point such as { year, rate } or { x, y }.
        if (entries.length === 2 && entries.every(([, v]) => isScalar(v))) {
          return `${String(entries[0][1])}: ${String(entries[1][1])}`;
        }
        return JSON.stringify(item);
      }
      return isScalar(item) ? String(item) : JSON.stringify(item);
    })
    .join(", ");
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value)
  );
}

/** A markdown table cell: pipes escaped, line breaks flattened. */
function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function escapeHeading(text: string): string {
  return text.replace(/\r?\n/g, " ");
}
