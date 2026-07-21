#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { ExtensionBridge } from "./extensionBridge.js";
import { registerBootstrapTool } from "./tools/bootstrap.js";
import { SnapshotManager } from "./snapshot.js";
import { log } from "./logger.js";

// Tools
import { registerConnectionTool } from "./tools/connection.js";
import { registerExportTool } from "./tools/export.js";
import { registerSchemaTool } from "./tools/schema.js";
import { registerSummaryTool } from "./tools/summary.js";
import { registerGetPlanTool } from "./tools/getPlan.js";
import { registerGetPlanSectionTool } from "./tools/getPlanSection.js";
import { registerGetCurrentFinancesTool } from "./tools/getCurrentFinances.js";
import { registerUpdateAccountTool } from "./tools/updateAccount.js";
import { registerUpdatePlanSectionTool } from "./tools/updatePlanSection.js";
import { registerUpdatePlanEventTool } from "./tools/updatePlanEvent.js";
import { registerRestoreTools } from "./tools/restore.js";
import { registerSnapshotTools } from "./tools/snapshots.js";

// Resources
import { registerPlanDataResource } from "./resources/planData.js";
import { registerSummaryResource } from "./resources/summary.js";
import { registerKnowledgeResource } from "./resources/knowledge.js";

// Prompts
import { registerPrompts } from "./prompts/index.js";

async function main() {
  const server = new McpServer(
    {
      name: "projectionlab",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {},
        resources: {},
        tools: {},
      },
    },
  );

  const bridge = new ExtensionBridge();
  registerBootstrapTool(server, bridge);
  const snapshots = new SnapshotManager();

  // Register read tools
  registerConnectionTool(server, bridge);
  registerExportTool(server, bridge);
  registerSchemaTool(server, bridge);
  registerSummaryTool(server, bridge);
  registerGetPlanTool(server, bridge);
  registerGetPlanSectionTool(server, bridge);
  registerGetCurrentFinancesTool(server, bridge);

  // Register write tools
  registerUpdateAccountTool(server, bridge, snapshots);
  registerUpdatePlanSectionTool(server, bridge, snapshots);
  registerUpdatePlanEventTool(server, bridge, snapshots);
  registerRestoreTools(server, bridge, snapshots);

  // Register snapshot/rollback tools
  registerSnapshotTools(server, bridge, snapshots);

  // Register resources
  registerPlanDataResource(server, bridge);
  registerSummaryResource(server, bridge);
  registerKnowledgeResource(server);

  // Register prompts
  registerPrompts(server, bridge);

  log.info("server", `WebSocket port: ${config.wsPort}`);
  log.info("server", `Read-only mode: ${config.readOnly}`);
  log.info("server", `Snapshot dir: ${config.snapshotDir}`);

  // Graceful shutdown
  const shutdown = async () => {
    log.info("server", "Shutting down...");
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("server", "ProjectionLab MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
