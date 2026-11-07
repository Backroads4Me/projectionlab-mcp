import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readGuide } from "../instructions.js";

export function registerGuideResource(server: McpServer) {
  server.registerResource(
    "guide",
    "projectionlab://guide",
    {
      title: "ProjectionLab MCP Agent Guide",
      description:
        "How to use this server: connection check and setup walkthrough, which tool answers " +
        "which question, the read-only/dry-run/confirm/rollback workflow for changes, and " +
        "privacy rules. Read this when projectionlab_check_connection reports a problem.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: readGuide(), mimeType: "text/markdown" }],
    }),
  );
}
