# builderfuze-mcp

MCP server for BuilderFuze. Lets users find collaborators, send connection requests, and act on BuilderFuze from inside Claude — without ever leaving the conversation.

## Status

**Phase 1 — stdio transport, stub data, no OAuth.**
Goal: validate the MCP protocol end-to-end in Claude Desktop.

Once stable, Phase 2 adds:
- HTTP transport (so Claude.ai web can use it)
- OAuth bridge to BuilderFuze
- Real data via BuilderFuze API calls
- Write tools (`send_connection_request`, `create_project`, etc.)

## Tools (current)

| Tool | What it does |
|---|---|
| `find_collaborators` | Synthesize project context → top 3 ranked matches with reasoning. The killer flow. |
| `search_builders` | Free-text / role-filtered builder search. |
| `get_builder` | Full public profile by ID. |

## Local development

```bash
npm install
npm run dev          # tsx watch — auto-reloads on save
npm run inspect      # opens MCP Inspector at the server
npm run build        # compile to dist/
```

## Installing in Claude Desktop

1. Build: `npm run build`
2. Config file: `~/Library/Application Support/Claude/claude_desktop_config.json`
3. Add:
   ```json
   "mcpServers": {
     "builderfuze": {
       "command": "node",
       "args": ["/Users/mattscott/Downloads/builderfuze-mcp/dist/server.js"]
     }
   }
   ```
4. Restart Claude Desktop fully (Quit + reopen)
5. Open a new conversation → 🔌 icon in the message bar → confirm "builderfuze" is connected
6. Try: *"I'm building a real-time canvas app with Next.js and Liveblocks. Find me a frontend co-founder who can help."*

## Iterating

Edit code → `npm run build` → restart Claude Desktop. Or use `npm run inspect` for a tighter loop (no Claude restart needed).

## Next phase (when ready)

- [ ] Replace stub data with calls to `https://builderfuze.vercel.app/api/match` (and friends)
- [ ] Move from stdio to Streamable HTTP transport
- [ ] Build OAuth flow (BuilderFuze `/connect/claude` consent page + this server's `/oauth/*` endpoints)
- [ ] Add write tools: `send_connection_request`, `message_connection`, `create_project`, `apply_to_project`
- [ ] Deploy to `mcp.builderfuze.com` (separate Vercel project)
- [ ] Make Pro-tier gating visible in tool responses
