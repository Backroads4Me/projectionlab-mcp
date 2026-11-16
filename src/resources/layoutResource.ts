import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { layoutForContract, type ExportLayout } from "../layout.js";

export interface LayoutResourceSpec {
  name: string;
  uri: string;
  title: string;
  description: string;
  render: (layout: ExportLayout) => string;
}

/**
 * Registers a markdown resource whose text follows the ProjectionLab layout.
 *
 * The plain URI is a fixed resource, so it is listed and read by exact match.
 * `<uri>?layout=v4` and `<uri>?layout=v5` are served by a URI template beside
 * it, because the SDK reads a fixed resource only when the requested URI
 * matches it exactly, query string included.
 */
export function registerLayoutResource(
  server: McpServer,
  bridge: Bridge | undefined,
  spec: LayoutResourceSpec,
) {
  const metadata = {
    title: spec.title,
    description: spec.description,
    mimeType: "text/markdown",
  };
  const read = async (uri: URL) => {
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
          text: spec.render(layout ?? "v4"),
          mimeType: "text/markdown",
        },
      ],
    };
  };

  server.registerResource(spec.name, spec.uri, metadata, read);
  server.registerResource(
    `${spec.name}-layout`,
    new ResourceTemplate(`${spec.uri}{?layout}`, { list: undefined }),
    metadata,
    read,
  );
}
