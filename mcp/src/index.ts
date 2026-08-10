import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const PORT = parseInt(process.env.PORT ?? "3002", 10);
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

function buildServer(): McpServer {
  const server = new McpServer({ name: "smartchef-mcp", version: "1.0.0" });
  registerTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "5mb" }));

// Stateless Streamable HTTP transport: a fresh MCP server + transport per
// request keeps this simple and avoids tracking session state across calls,
// which is fine for a tool-call-oriented server like this one.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: randomUUID(),
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed — this server only supports stateless POST requests." },
    id: null,
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", backend: BACKEND_URL });
});

app.listen(PORT, () => {
  console.log(`🍽️  SmartChef MCP Server running on :${PORT}`);
  console.log(`   Backend: ${BACKEND_URL}`);
  console.log(`   Endpoint: POST http://localhost:${PORT}/mcp`);
});
