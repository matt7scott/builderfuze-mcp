/**
 * BuilderFuze MCP server — HTTP entrypoint.
 *
 * Uses Streamable HTTP transport so Claude.ai web (not just Desktop) can
 * connect. Stateless: one MCP Server instance per request, scoped to the
 * authenticated user (once OAuth is wired in Phase 2.4).
 *
 *   npm run dev:http      — local on http://localhost:3001/mcp
 *
 * For production, this is the entrypoint Vercel runs. mcp.builderfuze.com
 * routes to it.
 */

import express, { type Request, type Response } from "express";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./mcp/tools.js";

const PORT = Number(process.env.PORT ?? 3001);

const app = express();

// JSON body for everything except the MCP endpoint (which handles its own
// parsing via Streamable HTTP). Keep JSON middleware off /mcp.
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  express.json()(req, res, next);
});

// --- Health ---
app.get("/", (_req, res) => {
  res.json({
    name: "builderfuze-mcp",
    version: "0.1.0",
    status: "ok",
    docs: "https://github.com/matt7scott/builderfuze-mcp",
  });
});

// --- MCP endpoint ---
// Note: OAuth middleware wraps this in Phase 2.4. For now, all calls work
// without auth (we'll be hitting BuilderFuze's API anonymously, getting
// public profile data only — same surface as the stdio dev server).
app.all("/mcp", async (req: Request, res: Response) => {
  // One Server instance per request. In Phase 2.4 we'll attach
  // user context from the verified bearer token.
  const mcpServer = new McpServer(
    {
      name: "builderfuze",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  registerTools(mcpServer);

  // Stateless transport — no session ID, each call is independent.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`builderfuze-mcp HTTP server ready at http://localhost:${PORT}/mcp`);
});
