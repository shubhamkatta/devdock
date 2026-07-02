#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "node:http";
import { createMcpServer } from "./mcp-server.js";

const REQUIRED_ENV = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const;

function loadConfig() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    console.error(`\nSet them in your environment or in a .env file:\n`);
    console.error(`  export JIRA_BASE_URL=https://yoursite.atlassian.net`);
    console.error(`  export JIRA_EMAIL=you@company.com`);
    console.error(`  export JIRA_API_TOKEN=your-token`);
    process.exit(1);
  }
  return {
    jira: {
      baseUrl: process.env.JIRA_BASE_URL!,
      email: process.env.JIRA_EMAIL!,
      apiToken: process.env.JIRA_API_TOKEN!,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "stdio";

  const config = loadConfig();
  const mcpServer = createMcpServer(config);

  if (mode === "stdio") {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
  } else if (mode === "sse") {
    const port = parseInt(args[1] ?? process.env.DEVDOCK_PORT ?? "3100", 10);
    const sessions = new Map<string, SSEServerTransport>();

    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        sessions.set(transport.sessionId, transport);
        res.on("close", () => sessions.delete(transport.sessionId));
        await mcpServer.connect(transport);
        return;
      }

      if (url.pathname === "/messages" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId");
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown session" }));
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    httpServer.listen(port, () => {
      console.error(`devdock MCP server (SSE) listening on http://localhost:${port}`);
      console.error(`  SSE endpoint:     GET  http://localhost:${port}/sse`);
      console.error(`  Message endpoint: POST http://localhost:${port}/messages`);
      console.error(`  Health check:     GET  http://localhost:${port}/health`);
    });
  } else {
    console.error(`Unknown mode: ${mode}. Use "stdio" (default) or "sse [port]".`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
