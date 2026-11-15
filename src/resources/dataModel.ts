import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import {
  DATA_MODEL_GROUPS,
  DATA_MODEL_PROJECTIONLAB_VERSION,
  DATA_MODEL_V5_GROUPS,
  DATA_MODEL_V5_PROJECTIONLAB_VERSION,
  type DataModelField,
} from "../dataModel.js";
import { layoutForContract, type ExportLayout } from "../layout.js";

function renderField(pattern: string, field: DataModelField): string {
  const parts = [`- \`${pattern}\` [${field.evidence}]: ${field.description}`];
  if (field.units) parts.push(`Units: ${field.units}.`);
  if (field.allowedValues) {
    parts.push(`Allowed values: ${field.allowedValues.join(", ")}.`);
  }
  if (field.enabledBy) parts.push(`Enabled by: ${field.enabledBy}.`);
  if (field.note) parts.push(`Note: ${field.note}`);
  return parts.join(" ");
}

export function renderDataModelV4Markdown(): string {
  const lines: string[] = [
    `# ProjectionLab Data Model (ProjectionLab ${DATA_MODEL_PROJECTIONLAB_VERSION})`,
    "",
    `Field reference for the values this server reads with \`listPaths\` and writes with the ` +
      `update tools. Paths are dot paths exactly as \`listPaths\` lists them and as ` +
      "`pathChanges` addresses them, relative to the listed object; `*` stands for any single " +
      "path segment, such as an array index or a withdrawal strategy name. Each group names " +
      "the scope the paths are listed and written under.",
    "",
    `Everything here describes ProjectionLab ${DATA_MODEL_PROJECTIONLAB_VERSION}. A future ` +
      "version (v5 and beyond) may rename fields, change units, or add and remove options. " +
      "Check the live values before writing.",
    "",
    "Evidence tags: [observed] means a value was set through the UI and the stored value was " +
      "read back (or matched field-for-field against a known plan). [ui-label] means the " +
      "control was seen in the UI but the entry is not yet confirmed by a stored-value test. " +
      "Writes are refused only on [observed] option lists.",
    "",
    "The most dangerous trap is the rate scale: most rates are stored in percentage points " +
      "(`variables.inflation: 3` means 3%), but the tax strategy bracket rates are stored as " +
      "decimal fractions (`variables.taxStrategy.bracketRate: 0.22` means 22%). Read the " +
      "current value first and write the new one on the same scale.",
    "",
  ];
  for (const group of DATA_MODEL_GROUPS) {
    lines.push(`## ${group.title}`, "");
    for (const [pattern, field] of Object.entries(group.fields)) {
      lines.push(renderField(pattern, field));
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderDataModelV5Markdown(): string {
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
    "- ProjectionLab 5 supports Solo 401k, Roth Solo 401k, and SEP IRA account types, but their export strings are not yet recorded.",
    "- Plan events carry a kind discriminator: account, real-asset, income, expense, or priority. " +
      "Plan account events link to Current Finances accounts via accountId, and asset events link via assetId. " +
      "Event timing is defined by timing objects with type (date, milestone, keyword), value, and optional modifier.",
    "- Plans carry no active flag. Both settings.plan.activeId and baselineId are null in exported documents; " +
      "no plan is treated as the selected plan.",
    "- Historical records are stored in documents.accountHistory keyed by account ID then calendar year, " +
      "without a separate progress section.",
    "",
    "Evidence tags: [export-shape] means the field and its value type appear in a " +
      "ProjectionLab 5 export; its meaning is not yet confirmed by a stored-value test.",
    "",
  ];
  for (const group of DATA_MODEL_V5_GROUPS) {
    lines.push(`## ${group.title}`, "");
    for (const [pattern, field] of Object.entries(group.fields)) {
      lines.push(renderField(pattern, field));
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderDataModelMarkdown(layout: ExportLayout = "v4"): string {
  return layout === "v5" ? renderDataModelV5Markdown() : renderDataModelV4Markdown();
}

export function registerDataModelResource(server: McpServer, bridge?: Bridge) {
  server.registerResource(
    "data-model",
    "projectionlab://data-model",
    {
      title: "ProjectionLab Data Model",
      description:
        `Field meanings, units, and allowed values for path-addressable reads and writes, ` +
        `version-stamped to ProjectionLab ${DATA_MODEL_PROJECTIONLAB_VERSION} (v4) and ` +
        `${DATA_MODEL_V5_PROJECTIONLAB_VERSION} (v5). Follows the connected ProjectionLab version once a connection check has run, and ProjectionLab 4 before that; append ?layout=v4 or ?layout=v5 to choose. ` +
        "Entries tagged ui-label or export-shape are not yet confirmed by a stored-value test.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      let layout: ExportLayout | undefined;
      const param = uri.searchParams.get("layout");
      if (param === "v5" || param === "v4") {
        layout = param;
      } else if (bridge) {
        // The contract the last connection check or write read; reading a
        // resource never waits on the browser.
        const contract = bridge.knownApiContract();
        if (contract !== undefined) layout = layoutForContract(contract);
      }
      return {
        contents: [
          {
            uri: uri.href,
            text: renderDataModelMarkdown(layout ?? "v4"),
            mimeType: "text/markdown",
          },
        ],
      };
    },
  );
}
