// Reads the layout-following resources through a real MCP client and server,
// so the SDK's own URI lookup decides which handler serves each address.

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { registerDataModelResource } = await import("../dist/resources/dataModel.js");
const { registerKnowledgeResource } = await import("../dist/resources/knowledge.js");

async function connect(contract) {
  const bridge = {
    knownApiContract: () => contract,
    apiContract: () => {
      throw new Error("a resource read must not query the page");
    },
  };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerDataModelResource(server, bridge);
  registerKnowledgeResource(server, bridge);
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

for (const name of ["data-model", "knowledge"]) {
  const base = `projectionlab://${name}`;

  test(`${base}?layout=v5 and ?layout=v4 resolve through the MCP protocol`, async () => {
    const client = await connect(undefined);
    const v5 = await readText(client, `${base}?layout=v5`);
    const v4 = await readText(client, `${base}?layout=v4`);
    const plain = await readText(client, base);
    assert.notEqual(v5, v4);
    assert.equal(plain, v4, "with no known contract the plain URI serves v4");
    await client.close();
  });

  test(`${base} follows a known contract 2 through the MCP protocol`, async () => {
    const client = await connect(2);
    const plain = await readText(client, base);
    const v5 = await readText(client, `${base}?layout=v5`);
    const v4 = await readText(client, `${base}?layout=v4`);
    assert.equal(plain, v5);
    assert.notEqual(plain, v4);
    await client.close();
  });
}

test("resources/list shows each plain URI once and templates/list shows the ?layout form", async () => {
  const client = await connect(undefined);
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, ["projectionlab://data-model", "projectionlab://knowledge"]);
  const { resourceTemplates } = await client.listResourceTemplates();
  const templates = resourceTemplates.map((t) => t.uriTemplate).sort();
  assert.deepEqual(templates, [
    "projectionlab://data-model{?layout}",
    "projectionlab://knowledge{?layout}",
  ]);
  await client.close();
});
