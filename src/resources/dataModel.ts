import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DATA_MODEL_GROUPS,
  DATA_MODEL_PROJECTIONLAB_VERSION,
  type DataModelField,
} from "../dataModel.js";

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

export function renderDataModelMarkdown(): string {
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

export function registerDataModelResource(server: McpServer) {
  server.registerResource(
    "data-model",
    "projectionlab://data-model",
    {
      title: "ProjectionLab Data Model",
      description:
        `Field meanings, units, and allowed values for path-addressable reads and writes, ` +
        `version-stamped to ProjectionLab ${DATA_MODEL_PROJECTIONLAB_VERSION}. Static. ` +
        "Entries tagged ui-label are not yet confirmed by a stored-value test.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: renderDataModelMarkdown(),
          mimeType: "text/markdown",
        },
      ],
    }),
  );
}
