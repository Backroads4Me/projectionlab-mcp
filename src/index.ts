#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { ExtensionBridge } from "./extensionBridge.js";
import { registerBootstrapTool } from "./tools/bootstrap.js";
import { SnapshotManager } from "./snapshot.js";
import { log } from "./logger.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { VERSION } from "./version.js";

// Tools
import { registerConnectionTool } from "./tools/connection.js";
import { registerExportTool } from "./tools/export.js";
import { registerSchemaTool } from "./tools/schema.js";
import { registerSummaryTool } from "./tools/summary.js";
import { registerGetPlanTool } from "./tools/getPlan.js";
import { registerGetPlanSectionTool } from "./tools/getPlanSection.js";
import { registerGetPlanSettingsTool } from "./tools/getPlanSettings.js";
import { registerGetCurrentFinancesTool } from "./tools/getCurrentFinances.js";
import { registerDiffTool } from "./tools/diff.js";
import { registerUpdateAccountTool } from "./tools/updateAccount.js";
import { registerUpdatePlanSectionTool } from "./tools/updatePlanSection.js";
import { registerUpdatePlanEventTool } from "./tools/updatePlanEvent.js";
import { registerClonePlanTool } from "./tools/clonePlan.js";
import { registerDeletePlanTool } from "./tools/deletePlan.js";
import { registerUpdatePlanSettingsTool } from "./tools/updatePlanSettings.js";
import { registerRestoreTools } from "./tools/restore.js";
import { registerSnapshotTools } from "./tools/snapshots.js";

// Resources
import { registerPlanDataResource } from "./resources/planData.js";
import { registerSummaryResource } from "./resources/summary.js";
import { registerKnowledgeResource } from "./resources/knowledge.js";
import { registerGuideResource } from "./resources/guide.js";

// Prompts
import { registerPrompts } from "./prompts/index.js";

async function main() {
  const server = new McpServer(
    {
      name: "projectionlab",
      version: VERSION,
    },
    {
      capabilities: {
        logging: {},
        resources: {},
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
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
  registerGetPlanSettingsTool(server, bridge);
  registerGetCurrentFinancesTool(server, bridge);
  // Compares snapshots against each other or against the live export, so it
  // needs the snapshot manager but never writes to it.
  registerDiffTool(server, bridge, snapshots);

  // Register write tools
  registerUpdateAccountTool(server, bridge, snapshots);
  registerUpdatePlanSectionTool(server, bridge, snapshots);
  registerUpdatePlanEventTool(server, bridge, snapshots);
  registerUpdatePlanSettingsTool(server, bridge, snapshots);
  registerClonePlanTool(server, bridge, snapshots);
  registerDeletePlanTool(server, bridge, snapshots);
  registerRestoreTools(server, bridge, snapshots);

  // Register snapshot/rollback tools
  registerSnapshotTools(server, bridge, snapshots);

  // Register resources
  registerPlanDataResource(server, bridge);
  registerSummaryResource(server, bridge);
  registerKnowledgeResource(server);
  registerGuideResource(server);

  // Register prompts
  registerPrompts(server, bridge);

  log.info("server", `WebSocket port: ${config.wsPort}`);
  log.info("server", `Read-only mode: ${config.readOnly}`);
  log.info("server", `Snapshot dir: ${config.snapshotDir}`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("server", "Shutting down...");
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // stdin EOF means the MCP host is gone; the SDK's stdio transport does not
  // act on it, so without this the process would linger and keep holding the
  // WebSocket port. Exiting releases it for the next session's server.
  process.stdin.on("end", () => {
    void shutdown();
  });

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("server", "ProjectionLab MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
