# builderfuze-mcp

Model Context Protocol server for BuilderFuze. Lets users find collaborators, send connection requests, and act on BuilderFuze from inside Claude — without ever leaving the conversation.

## Status

**Phase 2 complete.** OAuth-secured HTTP transport, 5 tools wired to live BuilderFuze API.

| | |
|---|---|
| Tools | `find_collaborators` · `search_builders` · `get_builder` · `send_connection_request` · `get_my_inbox` |
| Transports | stdio (Claude Desktop dev) · Streamable HTTP (Claude.ai web) |
| Auth | OAuth 2.1 + PKCE; JWT-signed access tokens wrapping Supabase identity |
| Data | Live BuilderFuze API (`/api/match`, `/api/profiles/[id]`, `/api/connections`, `/api/inbox`) |

⚠️ Production caveat: OAuth state is in-memory. Fine for low-traffic dev/demo (most flows land on the same warm function); needs Supabase-backed persistence before public launch.

## Architecture

```
[Claude]              [mcp.builderfuze.com]                [builderfuze.vercel.app]
    │                          │                                       │
    │  POST /oauth/authorize   │                                       │
    │─────────────────────────▶│                                       │
    │                          │  redirect /connect/claude             │
    │◀─────────────────────────│──────────────────────────────────────▶│
    │  Allow                                                           │
    │─────────────────────────────────────────────────────────────────▶│
    │                          │  bf_access_token + user_id            │
    │                          │◀──────────────────────────────────────│
    │                          │                                       │
    │  Bearer <our_jwt>        │                                       │
    │─────────────────────────▶│                                       │
    │  tools/call              │  Bearer <bf_supabase_jwt>             │
    │                          │──────────────────────────────────────▶│
    │                          │◀──────────────────────────────────────│
    │◀─────────────────────────│                                       │
    │  result                                                          │
```

## Local development

```bash
npm install
JWT_SECRET=$(openssl rand -base64 48) npm run dev:http   # http://localhost:3001
npm run inspect:http                                      # MCP Inspector UI
```

For Claude Desktop testing (stdio transport):
1. `npm run build`
2. Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "builderfuze": {
         "command": "node",
         "args": ["/Users/mattscott/Downloads/builderfuze-mcp/dist/server.js"]
       }
     }
   }
   ```
3. Restart Claude Desktop fully (⌘Q + reopen)

## Project structure

```
src/
├── app.ts                 ← Express app factory (transport-agnostic)
├── server.ts              ← stdio entrypoint (Claude Desktop local)
├── server-http.ts         ← HTTP entrypoint (local dev)
├── builderfuze-client.ts  ← Thin wrapper over BuilderFuze API
├── mcp/
│   └── tools.ts           ← 5 tool definitions + handlers
└── auth/
    ├── tokens.ts          ← JWT issue/verify
    └── oauth.ts           ← /oauth/* + /.well-known/* routes

api/
└── index.ts               ← Vercel serverless entrypoint
```

## Deploying to Vercel (mcp.builderfuze.com)

You need to do these steps manually — Vercel auth + DNS aren't scriptable from here.

### 1. Push to GitHub

```bash
# From this directory:
gh repo create matt7scott/builderfuze-mcp --public --source=. --remote=origin --push
# Or manually:
#   1. Create empty repo at github.com/new
#   2. git remote add origin git@github.com:matt7scott/builderfuze-mcp.git
#   3. git branch -M main && git push -u origin main
```

### 2. Create the Vercel project

1. vercel.com/new → Import the `builderfuze-mcp` repo
2. Framework preset: **Other**
3. Build command: `npm run build` (auto-detected from vercel.json)
4. Root directory: leave as `./`
5. Don't deploy yet — set env vars first

### 3. Set environment variables

In the Vercel project's Settings → Environment Variables, add:

| Key | Value |
|---|---|
| `JWT_SECRET` | Run `openssl rand -base64 48` — generate fresh, keep secret |
| `MCP_PUBLIC_URL` | `https://mcp.builderfuze.com` (the URL Claude will call) |
| `BUILDERFUZE_BASE_URL` | `https://builderfuze.vercel.app` (where consent redirect goes) |
| `BUILDERFUZE_API_URL` | `https://builderfuze.vercel.app` (where tool API calls go) |

All four are required for production.

### 4. Deploy

Click Deploy. First build takes ~1 minute. You'll get a `*.vercel.app` URL — verify the health endpoint:

```bash
curl https://your-project.vercel.app/
# {"name":"builderfuze-mcp","version":"0.1.0","status":"ok"}
```

### 5. Add custom domain

Vercel project → Settings → Domains → Add → `mcp.builderfuze.com`.

In your DNS provider, add a CNAME record:
```
mcp    CNAME    cname.vercel-dns.com.
```

Wait ~5 min for DNS propagation, then re-verify via the health endpoint at `https://mcp.builderfuze.com/`.

### 6. Install the connector in Claude.ai

1. claude.ai → Settings → Connectors → Add Custom Connector
2. URL: `https://mcp.builderfuze.com`
3. Claude auto-discovers OAuth, prompts for authorization, bounces you to `/connect/claude` on BuilderFuze, you click Allow, you're done.

### 7. Test the killer flow

In any Claude conversation:

> *"I'm building a real-time canvas app with Next.js and Liveblocks. I need a frontend co-founder who can scale WebSockets. Find me people who can help."*

Claude should call `find_collaborators`, surface 3 matched builders from BuilderFuze, and offer to send connection requests.

## What's next (Phase 3)

- [ ] Supabase-backed OAuth state persistence (so OAuth flows survive cold starts)
- [ ] Refresh-token rotation (we issue a 1h access token; longer sessions need refresh)
- [ ] Pro tier gating visible in tool responses ("Note: free tier — 3 requests/30d remaining")
- [ ] Submit to Anthropic's connector directory for discoverability
- [ ] Better match reasoning (once cousin's algorithm replaces current cosine search)
- [ ] Additional tools: `create_project`, `apply_to_project`, `message_connection`, `manage_invitations`
