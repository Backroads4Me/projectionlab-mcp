import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DATA_MODEL_V5_GROUPS,
  DATA_MODEL_V5_PROJECTIONLAB_VERSION,
  type DataModelField,
  enforcesAllowedValues,
  UI_LABELS_V5,
} from "../dataModel.js";
import {
  ACCOUNT_EVENT_LINKED_FIELDS,
  ASSET_EVENT_LINKED_FIELDS,
} from "../linkedFields.js";

function renderField(pattern: string, field: DataModelField): string {
  const parts = [`- \`${pattern}\` [${field.evidence}]: ${field.description}`];
  if (field.units) parts.push(`Units: ${field.units}.`);
  if (field.allowedValues) {
    parts.push(`Allowed values: ${field.allowedValues.join(", ")}.`);
    if (enforcesAllowedValues(field)) {
      parts.push("A write of any other value is refused.");
    }
  }
  if (field.enabledBy) parts.push(`Enabled by: ${field.enabledBy}.`);
  if (field.note) parts.push(`Note: ${field.note}`);
  if (field.uiLabel && field.uiLocation) {
    parts.push(`In the app (ProjectionLab 5.0.0): "${field.uiLabel}" under ${field.uiLocation}.`);
  }
  return parts.join(" ");
}

/** Every field whose ProjectionLab 5.0.0 label is recorded. */
function renderUiLabels(): string[] {
  const lines: string[] = [];
  for (const [scope, labels] of Object.entries(UI_LABELS_V5)) {
    for (const [path, [label, location]] of Object.entries(labels)) {
      lines.push(`- \`${scope}.${path}\`: "${label}" under ${location}.`);
    }
  }
  return lines;
}

export function renderDataModelMarkdown(): string {
  const lines: string[] = [
    `# ProjectionLab Data Model (ProjectionLab ${DATA_MODEL_V5_PROJECTIONLAB_VERSION})`,
    "",
    "Field reference for the values in ProjectionLab 5 exports. " +
      "The root document envelope carries schema version 1 and an exportedAt timestamp, " +
      "containing currentFinances, plans, settings, and accountHistory.",
    "",
    "Key characteristics of the ProjectionLab 5 layout:",
    "- Accounts live in documents.currentFinances.accounts keyed by account ID. " +
      "Each account record carries a kind discriminator: account (with balance and costBasis), " +
      "debt (with balance and optional securedByAssetId), or real-asset (with value and purchasePrice). " +
      "Archived accounts carry an archivedOn ISO date string.",
    "- The Solo 401k, Roth Solo 401k, and SEP IRA account types store as type \"401k\" or \"roth-401k\" with subtype \"solo\", and type \"ira\" with subtype \"sep\".",
    "- Plan events carry a kind discriminator: account, real-asset, income, expense, or priority. " +
      "Plan account events link to Current Finances accounts via accountId, and asset events link via assetId. " +
      "Event timing is defined by timing objects with type (date, milestone, keyword), value, and optional modifier.",
    "- Plans carry no active flag. settings.plan.activeId and baselineId are reported as stored, and " +
      "no plan is treated as the selected plan.",
    "- A priority's accountId names the plan account event it routes cash to, not a Current Finances account. " +
      "Event names need not be unique within a section; address an event by id when its name is ambiguous.",
    "- Historical records are stored in documents.accountHistory keyed by account ID then calendar year, " +
      "without a separate progress section.",
    "",
    "Evidence tags: [export-shape] means the field and its value type appear in a " +
      "ProjectionLab 5 export; its meaning is not yet confirmed by a stored-value test. " +
      "[observed] means a value was set through the ProjectionLab 5 UI and the stored value " +
      "was read back. Writes are refused only on [observed] option lists.",
    "",
  ];
  for (const group of DATA_MODEL_V5_GROUPS) {
    lines.push(`## ${group.title}`, "");
    for (const [pattern, field] of Object.entries(group.fields)) {
      lines.push(renderField(pattern, field));
    }
    lines.push("");
  }
  lines.push(
    "## Fields in the app",
    "",
    "Each field below was found in the app by writing a " +
      "distinct value to it or by matching a stored value to its control. Use the label and " +
      "location when telling the user where to look. A location in parentheses names the mode " +
      "or choice that must be selected for the control to appear.",
    "",
    ...renderUiLabels(),
    "",
    "## Fields the tools cannot change",
    "",
    "Do not write these, and do not try to reach them through another field. Tell the user " +
      "where to change them in the app instead.",
    "",
    "- Milestone settings (Whose Milestone, Count Progress From, Start a Chapter, Active in " +
      "This Plan, Marker on Charts, Warn if Never Reached) are not in the export.",
    "- Built-in milestones (retirement, life expectancy) have no `removable: true` and cannot " +
      "be deleted.",
    "- Events ProjectionLab generates, such as the Medicare expenses, carry " +
      '`_meta.deletion: "locked"`; leave them in place.',
    "- Derived figures are computed by the app and have no stored field: Monthly Benefit, " +
      "Full Retirement Age, Years to Pay Off, Real Return, and a real asset's equity and loan " +
      "balance.",
    "- Keys starting with an underscore (`_rothConversions`, `bondSettings._allocation`) are " +
      "switched-off copies; editing them changes nothing in the app.",
    "- A field that only applies in a mode, such as `incomeRate` while `generateIncome` is " +
      "off, has no effect until the user selects that mode.",
    "- A plan event linked to Current Finances takes some fields from the item it links " +
      "to, and ProjectionLab overwrites a value written to them in the plan. Writes to them " +
      "are refused; change them with projectionlab_update_account, which changes every plan " +
      "linked to that item. An account event with `accountId` takes " +
      `${ACCOUNT_EVENT_LINKED_FIELDS.map((f) => "`" + f + "`").join(", ")}. ` +
      "An asset event with `assetId` takes " +
      `${ASSET_EVENT_LINKED_FIELDS.map((f) => "`" + f + "`").join(", ")}. ` +
      "A priority with `accountId` takes `owner` and `icon` from the account it routes to " +
      "(a transfer priority takes only `owner`). listPaths on one event marks these paths " +
      "with `syncedFrom`. A field the event lists in `_meta.overriddenFields` keeps its plan " +
      "value, except on the baseline plan, which keeps no overrides.",
    "- Progress history is recorded by ProjectionLab 5; writing it is refused.",
    "- Switching a Social Security income to Estimate Benefit in the app also changes its " +
      "end and `taxExempt`; read the event again after the user switches modes.",
    "",
  );
  return lines.join("\n");
}

export function registerDataModelResource(server: McpServer) {
  server.registerResource(
    "data-model",
    "projectionlab://data-model",
    {
      title: "ProjectionLab Data Model",
      description:
        "Field meanings, units, and allowed values for path-addressable reads and writes, " +
        `version-stamped to ProjectionLab ${DATA_MODEL_V5_PROJECTIONLAB_VERSION}. ` +
        "Entries tagged export-shape are not yet confirmed by a stored-value test.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: renderDataModelMarkdown(), mimeType: "text/markdown" }],
    }),
  );
}
