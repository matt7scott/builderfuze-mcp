/**
 * OAuth 2.1 + PKCE endpoints for the BuilderFuze MCP server.
 *
 * Flow:
 *   1. Claude's MCP client discovers our OAuth endpoints via
 *      `/.well-known/oauth-protected-resource` and
 *      `/.well-known/oauth-authorization-server`.
 *   2. Claude dynamically registers as a client via /oauth/register.
 *   3. Claude redirects user to /oauth/authorize.
 *   4. We redirect the user to BuilderFuze's /connect/claude consent page.
 *   5. BuilderFuze redirects back to /oauth/callback with the user's
 *      Supabase access token (and identity).
 *   6. We mint an authorization code, redirect back to Claude.
 *   7. Claude exchanges code for an access token at /oauth/token.
 *   8. All subsequent /mcp calls include the access token as a Bearer.
 *
 * IMPORTANT: Phase 2.4 uses in-memory stores. Phase 2.6 (deploy) swaps
 * these for Postgres/Redis so they survive function cold starts on Vercel.
 */

import type { Express, Request, Response } from "express";
import express from "express";
import crypto from "node:crypto";
import { issueAccessToken } from "./tokens.js";

interface PendingAuth {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
  scope?: string;
  expires_at: number;
}

interface AuthCode {
  user_id: string;
  bf_access_token: string;
  bf_refresh_token?: string;
  tier: "free" | "pro";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
}

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  created_at: number;
}

// In-memory state — replace with persistent store in Phase 2.6
const pendingAuth = new Map<string, PendingAuth>();
const authCodes = new Map<string, AuthCode>();
const registeredClients = new Map<string, RegisteredClient>();

// Cleanup periodically (best-effort; serverless cold starts will reset anyway)
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of pendingAuth) if (v.expires_at < now) pendingAuth.delete(k);
    for (const [k, v] of authCodes) if (v.expires_at < now) authCodes.delete(k);
  },
  5 * 60 * 1000
);

export function registerOAuthRoutes(app: Express) {
  const baseUrl = process.env.MCP_PUBLIC_URL ?? "http://localhost:3001";
  const bfBaseUrl =
    process.env.BUILDERFUZE_BASE_URL ?? "https://builderfuze.vercel.app";

  // --- Discovery metadata --------------------------------------------------

  app.get("/.well-known/oauth-protected-resource", (_, res) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (_, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      scopes_supported: ["mcp"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], // public client + PKCE
    });
  });

  // --- Dynamic client registration ----------------------------------------

  app.post("/oauth/register", express.json(), (req, res) => {
    const redirect_uris = Array.isArray(req.body?.redirect_uris)
      ? (req.body.redirect_uris as string[])
      : [];
    if (redirect_uris.length === 0) {
      return res.status(400).json({ error: "redirect_uris is required" });
    }
    const client_id = `bf-mcp-${crypto.randomBytes(8).toString("hex")}`;
    registeredClients.set(client_id, {
      client_id,
      redirect_uris,
      created_at: Date.now(),
    });
    res.status(201).json({
      client_id,
      redirect_uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // --- /oauth/authorize ---------------------------------------------------
  // Claude redirects the user here. We stash params and bounce to BuilderFuze
  // for the actual consent.

  app.get("/oauth/authorize", (req: Request, res: Response) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
      scope,
    } = req.query as Record<string, string>;

    if (response_type !== "code") {
      return res.status(400).send("unsupported response_type (expected 'code')");
    }
    if (!client_id || !redirect_uri || !code_challenge) {
      return res
        .status(400)
        .send("client_id, redirect_uri, and code_challenge are required");
    }
    if ((code_challenge_method ?? "plain") !== "S256") {
      return res.status(400).send("code_challenge_method must be 'S256'");
    }

    // Validate registered client (if registered) or accept unknown clients
    // (some MCP clients call /authorize without prior registration)
    const client = registeredClients.get(client_id);
    if (client && !client.redirect_uris.includes(redirect_uri)) {
      return res.status(400).send("redirect_uri not registered for this client");
    }

    const session_id = crypto.randomBytes(16).toString("hex");
    pendingAuth.set(session_id, {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method: "S256",
      state,
      scope,
      expires_at: Date.now() + 10 * 60 * 1000, // 10 min
    });

    const callback = `${baseUrl}/oauth/callback?session_id=${session_id}`;
    res.redirect(
      `${bfBaseUrl}/connect/claude?callback=${encodeURIComponent(callback)}`
    );
  });

  // --- /oauth/callback ----------------------------------------------------
  // BuilderFuze's consent page redirects back here after the user clicks
  // "Allow". Query params: session_id, bf_access_token, user_id, [tier].

  app.get("/oauth/callback", (req: Request, res: Response) => {
    const {
      session_id,
      bf_access_token,
      bf_refresh_token,
      user_id,
      tier,
      error,
    } = req.query as Record<string, string>;

    const pending = session_id ? pendingAuth.get(session_id) : undefined;
    if (!pending) {
      return res.status(400).send("invalid or expired session");
    }
    pendingAuth.delete(session_id);

    if (error || !bf_access_token || !user_id) {
      // Bounce error back to Claude
      const u = new URL(pending.redirect_uri);
      u.searchParams.set("error", error ?? "access_denied");
      if (pending.state) u.searchParams.set("state", pending.state);
      return res.redirect(u.toString());
    }

    const code = crypto.randomBytes(24).toString("hex");
    authCodes.set(code, {
      user_id,
      bf_access_token,
      bf_refresh_token,
      tier: tier === "pro" ? "pro" : "free",
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      expires_at: Date.now() + 60 * 1000, // 60s
    });

    const u = new URL(pending.redirect_uri);
    u.searchParams.set("code", code);
    if (pending.state) u.searchParams.set("state", pending.state);
    res.redirect(u.toString());
  });

  // --- /oauth/token -------------------------------------------------------
  // Claude exchanges the authorization code (and PKCE verifier) for an
  // access token.

  app.post(
    "/oauth/token",
    express.urlencoded({ extended: true }),
    express.json(),
    async (req: Request, res: Response) => {
      const body = { ...(req.body ?? {}) };
      const { grant_type, code, code_verifier, client_id } = body;

      if (grant_type !== "authorization_code") {
        return res.status(400).json({ error: "unsupported_grant_type" });
      }
      if (!code || !code_verifier || !client_id) {
        return res.status(400).json({ error: "invalid_request" });
      }

      const entry = authCodes.get(code);
      if (!entry || entry.expires_at < Date.now()) {
        return res.status(400).json({ error: "invalid_grant" });
      }
      authCodes.delete(code); // single-use

      if (entry.client_id !== client_id) {
        return res.status(400).json({ error: "invalid_client" });
      }

      // Verify PKCE
      const hash = crypto
        .createHash("sha256")
        .update(String(code_verifier))
        .digest();
      const computed = hash.toString("base64url");
      if (computed !== entry.code_challenge) {
        return res.status(400).json({ error: "invalid_grant" });
      }

      const { access_token, expires_in } = await issueAccessToken({
        user_id: entry.user_id,
        bf_access_token: entry.bf_access_token,
        bf_refresh_token: entry.bf_refresh_token,
        tier: entry.tier,
      });

      res.json({
        access_token,
        token_type: "Bearer",
        expires_in,
        scope: "mcp",
      });
    }
  );
}
