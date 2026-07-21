import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { textOrFile } from "../largeOutput.js";

export function registerGetCurrentFinancesTool(
  server: McpServer,
  bridge: Bridge,
) {
  server.registerTool(
    "projectionlab_get_current_finances",
    {
      title: "Get Current Finances",
      description:
        "Returns just the Current Finances section (account balances, debts, real estate) " +
        "without any plan data. Typically ~20-30K chars. " +
        "Use this when you need current account balances without the full export.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const data = await bridge.exportData();

        if (!data.today) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            "No current finances data found in ProjectionLab",
            "Set up your current finances in ProjectionLab first",
          );
        }

        return {
          content: [
            {
              type: "text",
              text: await textOrFile(toJson(data.today), "current-finances"),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
