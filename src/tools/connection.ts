import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { config } from "../config.js";
import { errorResult } from "../errors.js";
import { toJson } from "../json.js";

export function registerConnectionTool(
  server: McpServer,
  bridge: Bridge,
) {
  server.registerTool(
    "projectionlab_check_connection",
    {
      title: "Check Connection",
      description:
        "Verify connectivity to ProjectionLab. Checks that the browser is running, " +
        "the ProjectionLab page is loaded, the Plugin API is accessible, and the API key is valid. " +
        "Also reports writesEnabled, which is false while the server is in read-only mode " +
        "(PL_READ_ONLY is not \"false\") and every write tool, dry runs included, is refused. " +
        "Call this first in every session, before any other ProjectionLab tool. If any check " +
        "fails, read the projectionlab://guide resource and walk the user through the fix.",
      outputSchema: {
        browser: z.boolean(),
        pageLoaded: z.boolean(),
        apiAvailable: z.boolean(),
        apiKeyValid: z.boolean(),
        errors: z.array(z.string()),
        writesEnabled: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const status = {
          ...(await bridge.checkConnection()),
          writesEnabled: !config.readOnly,
        };
        return {
          content: [{ type: "text", text: toJson(status) }],
          structuredContent: { ...status },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "projectionlab_describe_plugin_api",
    {
      title: "Describe Plugin API",
      description:
        "Lists the methods and properties exposed by window.projectionlabPluginAPI in the " +
        "running app build. Use this to discover undocumented capabilities (e.g. reading " +
        "computed projection results) before assuming a method does not exist.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const api = await bridge.describePluginApi();
        return {
          content: [{ type: "text", text: toJson(api) }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
