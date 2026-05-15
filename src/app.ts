/**
 * Express app builder — pure construction, no port binding.
 *
 * server-http.ts (local dev) and api/index.ts (Vercel) both import the
 * `app` from here. This separation lets us run as a long-lived Node process
 * locally and as a serverless function on Vercel without code drift.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./mcp/tools.js";
import { registerOAuthRoutes } from "./auth/oauth.js";
import { verifyAccessToken, type AccessTokenClaims } from "./auth/tokens.js";

const REQUIRE_AUTH = process.env.MCP_REQUIRE_AUTH !== "false";

declare module "express-serve-static-core" {
  interface Request {
    mcpSession?: AccessTokenClaims;
  }
}

export function createApp() {
  const app = express();

  app.get("/", (_req, res) => {
    res.json({
      name: "builderfuze-mcp",
      version: "0.1.0",
      status: "ok",
      docs: "https://github.com/matt7scott/builderfuze-mcp",
    });
  });

  registerOAuthRoutes(app);

  async function authenticate(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (!REQUIRE_AUTH) return next();

    const auth = req.headers.authorization ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) {
      const base = process.env.MCP_PUBLIC_URL ?? "http://localhost:3001";
      res.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`
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

  app.all("/mcp", authenticate, async (req: Request, res: Response) => {
    const mcpServer = new McpServer(
      { name: "builderfuze", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
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

  return app;
}
