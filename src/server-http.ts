/**
 * BuilderFuze MCP server — HTTP entrypoint.
 *
 * Streamable HTTP transport so Claude.ai web can connect. Each /mcp request
 * is stateless; one MCP Server instance per request, scoped to the
 * authenticated user via the bearer access token.
 *
 *   npm run dev:http      — local on http://localhost:3001/mcp
 *
 * For production, Vercel runs this entrypoint. mcp.builderfuze.com routes
 * here.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./mcp/tools.js";
import { registerOAuthRoutes } from "./auth/oauth.js";
import { verifyAccessToken, type AccessTokenClaims } from "./auth/tokens.js";

const PORT = Number(process.env.PORT ?? 3001);
const REQUIRE_AUTH = process.env.MCP_REQUIRE_AUTH !== "false";

const app = express();

// Health
app.get("/", (_req, res) => {
  res.json({
    name: "builderfuze-mcp",
    version: "0.1.0",
    status: "ok",
    docs: "https://github.com/matt7scott/builderfuze-mcp",
  });
});

// OAuth + discovery routes (no auth required)
registerOAuthRoutes(app);

// Auth middleware: extracts bearer, verifies, attaches session
declare module "express-serve-static-core" {
  interface Request {
    mcpSession?: AccessTokenClaims;
  }
}

async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!REQUIRE_AUTH) {
    // Dev mode: skip auth, anonymous BF API calls
    return next();
  }

  const auth = req.headers.authorization ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) {
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`}/.well-known/oauth-protected-resource"`
    );
    res.status(401).json({ error: "missing bearer token" });
    return;
  }

  const claims = await verifyAccessToken(token);
  if (!claims) {
    res.set("WWW-Authenticate", `Bearer error="invalid_token"`);
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  req.mcpSession = claims;
  next();
}

// MCP endpoint — auth + per-request MCP Server instance
app.all("/mcp", authenticate, async (req: Request, res: Response) => {
  const mcpServer = new McpServer(
    { name: "builderfuze", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // Pass session context to tools so they can call BuilderFuze API as
  // the authenticated user (Phase 2.5 wires the bearer into bfFetch).
  registerTools(mcpServer, req.mcpSession);

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
  console.log(`  auth required: ${REQUIRE_AUTH}`);
  console.log(`  BuilderFuze API: ${process.env.BUILDERFUZE_API_URL ?? "https://builderfuze.vercel.app"}`);
});
