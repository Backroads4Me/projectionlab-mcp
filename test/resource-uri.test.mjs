// Reads the reference resources through a real MCP client and server, so the
// SDK's own URI lookup decides which handler serves each address.

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { registerDataModelResource } = await import("../dist/resources/dataModel.js");
const { registerKnowledgeResource } = await import("../dist/resources/knowledge.js");

async function connect() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerDataModelResource(server);
  registerKnowledgeResource(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function readText(client, uri) {
  const result = await client.readResource({ uri });
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].uri, uri);
  return result.contents[0].text;
}

for (const [name, heading] of [
  ["data-model", /^# ProjectionLab Data Model \(ProjectionLab 5\./],
  ["knowledge", /^# ProjectionLab 5 & FIRE Reference/],
]) {
  const uri = `projectionlab://${name}`;

  test(`${uri} serves the ProjectionLab 5 reference through the MCP protocol`, async () => {
    const client = await connect();
    const text = await readText(client, uri);
    assert.match(text, heading);
    assert.doesNotMatch(text, /\?layout=/);
    await client.close();
  });

  test(`${uri}?layout=v4 is not a resource`, async () => {
    const client = await connect();
    await assert.rejects(client.readResource({ uri: `${uri}?layout=v4` }));
    await client.close();
  });
}

test("resources/list shows each URI once and there are no resource templates", async () => {
  const client = await connect();
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, ["projectionlab://data-model", "projectionlab://knowledge"]);
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.deepEqual(resourceTemplates, []);
  await client.close();
});
