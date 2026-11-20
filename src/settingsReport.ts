import { isDeepStrictEqual } from "node:util";
import { matchDataModelField, type DataModelField } from "./dataModel.js";
import type { ExportLayout } from "./layout.js";
import {
  PLAN_SETTING_SECTIONS,
  listPlanSettings,
  type PlanSettingSection,
} from "./planSettings.js";
import { getEvents, milestoneNames, startLabel, type PlanObj } from "./plans.js";
import { redactSecrets } from "./redact.js";
import {
  REPORT_TOPICS,
  TIER_TITLES,
  VALUE_NAMES,
  valueNamesFor,
  type ReportTier,
  type ReportTopic,
  type RowCondition,
  type TopicRow,
} from "./settingsReportLayout.js";

/** Shown for a setting one compared plan holds and the other does not. */
const NOT_SET = "not set";

export interface SettingsReportOptions {
  section?: PlanSettingSection;
  /** Two-plan reports only: leave out the rows whose values match. */
  differencesOnly?: boolean;
}

/** One plan's settings, read once for every row. */
interface PlanView {
  name: string;
  sections: Record<PlanSettingSection, unknown>;
  /** Stored leaf paths by section, each claimed by at most one row. */
  leaves: Record<PlanSettingSection, Map<string, unknown>>;
  milestones: Map<string, string>;
  accounts: Map<string, string>;
}

interface Cell {
  present: boolean;
  text: string;
  /** The stored values the cell shows, compared across plans. */
  raw: unknown[];
}

interface Row {
  name: string;
  /** False when the name is the report's wording, not an on-screen label. */
  onScreen: boolean;
  /** True when the name is the stored path, for settings the report has no name for. */
  isPath?: boolean;
  cells: Cell[];
  differs: boolean;
  /** True when the row is in effect in none of the plans that hold it. */
  notInEffect?: boolean;
  /** The row's own conditions in words, beyond its topic's. */
  usedWhen?: string;
}

interface TopicBlock {
  title: string;
  tier: ReportTier;
  rows: Row[];
  /** The topic's own conditions in words, shown once under its heading. */
  usedWhen?: string;
  /** The most topic conditions any plan meets, to list the nearest choice first. */
  metCount: number;
}

/**
 * The settings of one plan, or of two plans side by side, as a markdown
 * document. Settings are grouped into the topics of REPORT_TOPICS, in its
 * order: main settings first, then more and advanced ones. A setting whose
 * controlling field (the data model's enabledBy, or the topic's own
 * condition) makes it unused in every plan is listed after them under "Not
 * in effect", and stored paths no topic names close the report.
 */
export function renderSettingsReport(
  plans: readonly PlanObj[],
  layout: ExportLayout,
  options: SettingsReportOptions = {},
): string {
  const compare = plans.length === 2;
  const views = plans.map((plan) => planView(plan));
  const sections = options.section ? [options.section] : PLAN_SETTING_SECTIONS;

  const blocks: TopicBlock[] = [];
  for (const topic of REPORT_TOPICS) {
    if (!sections.includes(topic.section)) continue;
    const rows = topic.rows
      .map((row) => buildRow(topic, row, views, layout))
      .filter((row): row is Row => row !== undefined);
    if (rows.length === 0) continue;
    const topicConditions = topic.appliesWhen ?? [];
    blocks.push({
      title: topic.title,
      tier: topic.tier,
      rows,
      usedWhen: conditionsText(topic.section, topicConditions, layout),
      metCount: Math.max(
        ...views.map(
          (view) =>
            topicConditions.filter((c) => conditionMet(view.sections[topic.section], c)).length,
        ),
      ),
    });
  }
  const other: Row[] = [];
  for (const section of sections) {
    const paths = new Set(views.flatMap((view) => [...view.leaves[section].keys()]));
    for (const path of [...paths].sort()) {
      other.push({
        ...makeRow(
          path,
          false,
          views.map((view) => valueCell(view.leaves[section], path, undefined)),
        ),
        isPath: true,
      });
    }
  }

  const allRows = [...blocks.flatMap((block) => block.rows), ...other];
  const differing = allRows.filter((row) => row.differs).length;
  const keep = (row: Row) => !(compare && options.differencesOnly) || row.differs;

  const lines: string[] = [];
  const names = views.map((view) => view.name);
  lines.push(
    compare
      ? `# Plan settings: ${names[0]} vs ${names[1]}`
      : `# Plan settings: ${names[0]}`,
    "",
  );
  lines.push(
    compare
      ? `${differing} of ${allRows.length} settings differ between the two plans.` +
          (options.differencesOnly ? " Only the differing settings are listed." : "")
      : `${allRows.length} settings.`,
    "",
    "Main settings come first, then more and advanced ones. Plain names are the labels " +
      "ProjectionLab 5 shows; names in *italics* describe a setting with no recorded label, " +
      "and the app may word them differently. Settings the plan's current choices leave " +
      "unused are listed near the end, with the choice that would use them.",
    "",
  );

  for (const tier of Object.keys(TIER_TITLES) as ReportTier[]) {
    const tierBlocks = blocks
      .filter((block) => block.tier === tier)
      .map((block) => ({ ...block, rows: block.rows.filter((row) => !row.notInEffect && keep(row)) }))
      .filter((block) => block.rows.length > 0);
    if (tierBlocks.length === 0) continue;
    lines.push(`## ${TIER_TITLES[tier]}`, "");
    for (const block of tierBlocks) {
      lines.push(`### ${block.title}`, "", ...table(block.rows, names, false), "");
    }
  }

  const unused = orderUnused(
    blocks
      .map((block) => ({ ...block, rows: block.rows.filter((row) => row.notInEffect && keep(row)) }))
      .filter((block) => block.rows.length > 0),
  );
  if (unused.length > 0) {
    lines.push(
      "## Not in effect with the current choices",
      "",
      "These settings are stored but unused until the choice named with them is made.",
      "",
    );
    for (const block of unused) {
      lines.push(`### ${block.title}`, "");
      if (block.usedWhen) lines.push(`Used when ${block.usedWhen}.`, "");
      const column = block.rows.some((row) => row.usedWhen);
      lines.push(...table(block.rows, names, column), "");
    }
  }

  const otherShown = other.filter(keep);
  if (otherShown.length > 0) {
    lines.push(
      "## Other stored settings",
      "",
      "Stored settings this report has no name for, by stored path.",
      "",
      ...table(otherShown, names, false),
      "",
    );
  }

  if (compare && options.differencesOnly && differing === 0) {
    lines.push("The two plans' settings match.", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function planView(plan: PlanObj): PlanView {
  const sections = {} as Record<PlanSettingSection, unknown>;
  const leaves = {} as Record<PlanSettingSection, Map<string, unknown>>;
  for (const section of PLAN_SETTING_SECTIONS) {
    const data = redactSecrets(plan[section], { byName: true });
    sections[section] = data;
    // No section argument, so rate schedules stay whole arrays.
    leaves[section] = new Map(
      listPlanSettings(data).map((setting) => [setting.path, setting.value]),
    );
  }
  const accounts = new Map<string, string>();
  const accountSection = plan.accounts;
  for (const event of getEvents(accountSection)) {
    if (!event || typeof event !== "object") continue;
    const { id, name } = event as PlanObj;
    if (typeof id === "string" && typeof name === "string" && name !== "") {
      accounts.set(id, name);
    }
  }
  return {
    name:
      typeof plan.name === "string" && plan.name.length > 0
        ? plan.name
        : String(plan.id ?? "Unnamed plan"),
    sections,
    leaves,
    milestones: milestoneNames(plan),
    accounts,
  };
}

function buildRow(
  topic: ReportTopic,
  row: TopicRow,
  views: readonly PlanView[],
  layout: ExportLayout,
): Row | undefined {
  const field = matchDataModelField(topic.section, row.path, layout);
  const cells = views.map((view) => readCell(topic.section, row, view, field));
  if (!cells.some((cell) => cell.present)) return undefined;

  const label = field?.uiLabel;
  const onScreen = label !== undefined;
  const name = label
    ? row.context
      ? `${row.context}: ${label}`
      : label
    : (row.name ?? row.path);

  const own = [...(topic.rowAppliesWhen?.[row.path] ?? []), ...parseEnabledBy(field?.enabledBy)];
  const conditions = [...(topic.appliesWhen ?? []), ...own];
  const result: Row = { ...makeRow(name, onScreen, cells), isPath: !onScreen && !row.name };
  if (conditions.length > 0) {
    result.notInEffect = views.every(
      (view, index) =>
        !cells[index].present ||
        conditions.some((condition) => !conditionMet(view.sections[topic.section], condition)),
    );
    result.usedWhen = conditionsText(topic.section, own, layout);
  }
  return result;
}

function makeRow(name: string, onScreen: boolean, cells: Cell[]): Row {
  const differs =
    cells.length === 2 &&
    (cells[0].present !== cells[1].present || !isDeepStrictEqual(cells[0].raw, cells[1].raw));
  return { name, onScreen, cells, differs };
}

/**
 * Reads one row's value from one plan, claiming the leaf paths it shows so
 * they are not listed again under "Other stored settings".
 */
function readCell(
  section: PlanSettingSection,
  row: TopicRow,
  view: PlanView,
  field: DataModelField | undefined,
): Cell {
  const leaves = view.leaves[section];
  const kind = row.kind ?? "value";
  if (kind === "value" || kind === "points" || kind === "accounts" || kind === "order") {
    const cell = valueCell(leaves, row.path, field?.units, field?.allowedValues);
    if (cell.present) {
      const value = cell.raw[0];
      if (kind === "points") cell.text = formatPoints(value, "%");
      if (kind === "order" && Array.isArray(value)) {
        const names = valueNamesFor(row.path);
        cell.text = value.map((item) => names?.[String(item)] ?? String(item)).join(" → ");
      }
      if (kind === "accounts" && Array.isArray(value)) {
        cell.text = value
          .map((id) => view.accounts.get(String(id)) ?? String(id))
          .join(" → ");
        // Account event ids are per plan, so plans compare by the names shown.
        cell.raw = [cell.text];
      }
    }
    return cell;
  }

  const claimed: [string, unknown][] = [];
  const claim = (path: string) => {
    if (leaves.has(path)) {
      claimed.push([path, leaves.get(path)]);
      leaves.delete(path);
    }
  };
  const prefix = `${row.path}.`;
  if (kind === "bound") {
    claim(row.path);
    claim(`${row.path}Enabled`);
    claim(`${row.path}Type`);
  } else {
    claim(row.path);
    for (const path of [...leaves.keys()]) if (path.startsWith(prefix)) claim(path);
  }
  if (claimed.length === 0) return { present: false, text: NOT_SET, raw: [] };
  const raw = claimed.sort(([a], [b]) => a.localeCompare(b));
  const value = (key: string) =>
    raw.find(([path]) => path === key)?.[1];

  if (kind === "bound") {
    const enabled = value(`${row.path}Enabled`);
    const amount = value(row.path);
    const type = value(`${row.path}Type`);
    return { present: true, text: formatBound(enabled, amount, type), raw };
  }
  if (kind === "reference") {
    const reference = {
      type: value(`${prefix}type`),
      value: value(`${prefix}value`),
      modifier: value(`${prefix}modifier`),
    };
    const text =
      reference.type === "keyword" && typeof reference.value === "string"
        ? words(reference.value)
        : startLabel(reference, view.milestones);
    const modifier =
      typeof reference.modifier === "string" ? ` (${reference.modifier})` : "";
    // Milestone ids are per plan, so a resolved reference compares by its words.
    return text === undefined
      ? { present: true, text: formatList(raw), raw }
      : { present: true, text: text + modifier, raw: [text + modifier] };
  }
  // curve: { type, data: [ { x, y } ] }, or a schedule stored as one array
  const type = value(`${prefix}type`);
  const data = value(`${prefix}data`);
  const whole = value(row.path);
  return {
    present: true,
    text: Array.isArray(data)
      ? formatPoints(data, type === "%" ? "%" : "")
      : whole !== undefined && raw.length === 1
        ? formatValue(whole)
        : formatList(raw),
    raw,
  };
}

function valueCell(
  leaves: Map<string, unknown>,
  path: string,
  units: string | undefined,
  allowedValues?: readonly string[],
): Cell {
  if (!leaves.has(path)) return { present: false, text: NOT_SET, raw: [] };
  const value = leaves.get(path);
  leaves.delete(path);
  const text = choiceText(path, value, allowedValues) ?? formatValue(value, units);
  return { present: true, text, raw: [value] };
}

/**
 * A stored choice in words: its VALUE_NAMES name, or, for a value the data
 * model lists as one of the field's allowed values, the code split into
 * words ("decrease-drawdown" as "Decrease drawdown", "netWorth" as "Net
 * worth"). Undefined for any other value.
 */
function choiceText(
  path: string,
  value: unknown,
  allowedValues: readonly string[] | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const named = valueNamesFor(path)?.[value];
  if (named !== undefined) return named;
  if (!allowedValues?.includes(value) || !/^[a-z][a-zA-Z]*(?:-[a-zA-Z]+)*$/.test(value)) {
    return undefined;
  }
  return words(value);
}

/** A stored code split into words: "decrease-drawdown" as "Decrease drawdown". */
function words(code: string): string {
  const text = code
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/-/g, " ")
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The data model's enabledBy as conditions. Three forms are read: `field`
 * (truthy), `field "value"`, and `field false`; anything else yields no
 * condition, so the setting stays where it is.
 */
export function parseEnabledBy(enabledBy: string | undefined): RowCondition[] {
  if (!enabledBy) return [];
  const match = /^([\w.%/-]+)(?: (?:"([^"]*)"|(true|false)))?$/.exec(enabledBy.trim());
  if (!match) return [];
  const [, path, text, bool] = match;
  if (text !== undefined) return [{ path, equals: text }];
  if (bool !== undefined) return [{ path, equals: bool === "true" }];
  return [{ path }];
}

function conditionMet(sectionData: unknown, condition: RowCondition): boolean {
  const value = readPath(sectionData, condition.path);
  // A controlling field the plan does not store says nothing either way.
  if (value === undefined) return true;
  return condition.equals === undefined
    ? Boolean(value)
    : isDeepStrictEqual(value, condition.equals);
}

/**
 * Unused topics in report order, except that among the topics with their own
 * conditions (the withdrawal rules), the ones nearest to being in effect come
 * first: with the textbook switch off, the selected rule leads.
 */
function orderUnused(blocks: readonly TopicBlock[]): TopicBlock[] {
  const conditioned = blocks.filter((block) => block.usedWhen);
  const first = blocks.indexOf(conditioned[0]);
  if (first < 0) return [...blocks];
  const sorted = [...conditioned].sort((a, b) => b.metCount - a.metCount);
  return [
    ...blocks.slice(0, first).filter((block) => !block.usedWhen),
    ...sorted,
    ...blocks.slice(first).filter((block) => !block.usedWhen),
  ];
}

function conditionsText(
  section: PlanSettingSection,
  conditions: readonly RowCondition[],
  layout: ExportLayout,
): string | undefined {
  if (conditions.length === 0) return undefined;
  return conditions.map((condition) => conditionText(section, condition, layout)).join(" and ");
}

function conditionText(
  section: PlanSettingSection,
  condition: RowCondition,
  layout: ExportLayout,
): string {
  const field = matchDataModelField(section, condition.path, layout);
  const topicRow = REPORT_TOPICS.filter((topic) => topic.section === section)
    .flatMap((topic) => topic.rows)
    .find((row) => row.path === condition.path);
  const name = field?.uiLabel ?? topicRow?.name;
  const subject = name ? (field?.uiLabel ? name : `*${name}*`) : `\`${condition.path}\``;
  if (condition.equals === undefined || condition.equals === true) return `${subject} is On`;
  if (condition.equals === false) return `${subject} is Off`;
  const shown =
    choiceText(condition.path, condition.equals, field?.allowedValues) ??
    String(condition.equals);
  return `${subject} is ${shown}`;
}

function readPath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function table(rows: readonly Row[], names: readonly string[], condition: boolean): string[] {
  const compare = names.length === 2;
  const head = compare
    ? ["Setting", cell(names[0]), cell(names[1]), "Differs"]
    : ["Setting", "Value"];
  const align = compare ? ["---", "---", "---", ":---:"] : ["---", "---"];
  if (condition) {
    head.push("Used when");
    align.push("---");
  }
  const lines = [`| ${head.join(" | ")} |`, `| ${align.join(" | ")} |`];
  for (const row of rows) {
    const name = row.onScreen
      ? cell(row.name)
      : row.isPath
        ? `\`${cell(row.name)}\``
        : `*${cell(row.name)}*`;
    const values = row.cells.map((entry) => cell(entry.text));
    const parts = [name, ...values];
    if (compare) parts.push(row.differs ? "**Yes**" : "");
    if (condition) parts.push(row.usedWhen ?? "");
    lines.push(`| ${parts.join(" | ")} |`);
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
    case "dollars":
      return dollars(value);
    default:
      return trim(value);
  }
}

function dollars(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** A withdrawal bound: Off, or its amount in its basis. */
function formatBound(enabled: unknown, amount: unknown, type: unknown): string {
  if (enabled === false) return "Off";
  if (typeof amount !== "number") return formatValue(amount);
  if (type === "%") return `${trim(amount)}%`;
  const basis =
    typeof type === "string" ? VALUE_NAMES.dollarBasis[type] : undefined;
  return basis ? `${dollars(amount)} in ${basis}` : trim(amount);
}

/** Points such as { x, y } as "x: y" pairs, y with a suffix. */
function formatPoints(value: unknown, suffix: string): string {
  if (!Array.isArray(value)) return formatValue(value);
  if (value.length === 0) return "(empty list)";
  return value
    .map((point) => {
      if (point && typeof point === "object" && !Array.isArray(point)) {
        const { x, y } = point as Record<string, unknown>;
        if (x !== undefined && y !== undefined) return `${String(x)}: ${String(y)}${suffix}`;
      }
      return JSON.stringify(point);
    })
    .join(", ");
}

/** Values of a composite row no formatter reads, as path = value pairs. */
function formatList(raw: readonly [string, unknown][]): string {
  return raw.map(([path, value]) => `${path} = ${formatValue(value)}`).join("; ");
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
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** A markdown table cell: pipes escaped, line breaks flattened. */
function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
