import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionBridge } from "../extensionBridge.js";

/** Only registered when the extension transport is active. */
export function registerBootstrapTool(server: McpServer, bridge: ExtensionBridge) {
  server.registerTool(
    "projectionlab_get_bootstrap",
    {
      title: "Get Bootstrap Snippet",
      description:
        "Returns a JavaScript snippet the user pastes into the ProjectionLab tab's devtools " +
        "console to connect that tab to this server - a zero-install alternative to the browser " +
        "extension. Use when check_connection reports no executor connected and the user has not " +
        "installed the extension. The snippet lasts until the tab reloads.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [
        {
          type: "text",
          text:
            "Paste this into the devtools console (F12) of a logged-in https://app.projectionlab.com tab:\n\n" +
            bridge.bootstrapSnippet(),
        },
      ],
    }),
  );
}
