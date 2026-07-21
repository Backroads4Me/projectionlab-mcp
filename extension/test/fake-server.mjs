#!/usr/bin/env node
import { WebSocketServer, WebSocket } from "ws";
const port = Number(process.env.PLMCP_TEST_PORT || process.argv[2] || 8788);
const token = process.env.PLMCP_TEST_TOKEN || process.argv[3] || "development-token";
const apiKey = process.env.PL_API_KEY || "replace-with-real-api-key";
const server = new WebSocketServer({ host: "127.0.0.1", port });
const request = (ws, id, method, params = []) => ws.send(JSON.stringify({ type: "request", id, method, params }));
server.on("connection", (ws) => {
  let authed = false;
  ws.on("message", (raw) => {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { ws.close(1003, "invalid JSON"); return; }
    if (!authed) {
      if (frame.type !== "hello" || frame.token !== token) { ws.close(4001, "bad token"); return; }
      if (frame.protocolVersion !== 1) { ws.close(4002, "protocol mismatch"); return; }
      authed = true;
      ws.send(JSON.stringify({ type: "helloAck", protocolVersion: 1 }));
      request(ws, "describe-1", "describeApi");
      return;
    }
    if (frame.type !== "response") return;
    process.stdout.write(`${JSON.stringify(frame, null, 2)}\n`);
    if (frame.id === "describe-1") request(ws, "export-1", "exportData", [{ key: apiKey }]);
    if (frame.id === "export-1") ws.close(1000, "test complete");
  });
  const heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, 20_000);
  ws.on("close", () => clearInterval(heartbeat));
});
process.stdout.write(`Fake server listening on ws://127.0.0.1:${port}; token: ${token}\n`);
