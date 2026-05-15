/**
 * BuilderFuze MCP server — entrypoint.
 *
 * Phase 1 (today): stdio transport, stub data, no auth.
 *   Goal: validate the MCP protocol works end-to-end in Claude Desktop +
 *   MCP Inspector. Once this is solid, we swap to HTTP + OAuth and wire
 *   the tools to BuilderFuze's real API.
 *
 * Run locally:   npm run dev
 * Test via UI:   npm run inspect    (opens MCP Inspector)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./mcp/tools.js";

async function main() {
  const server = new Server(
    {
      name: "builderfuze",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Helpful breadcrumb in stderr (stdout is reserved for MCP protocol)
  console.error("builderfuze-mcp: stdio server ready");
}

main().catch((err) => {
  console.error("builderfuze-mcp fatal error:", err);
  process.exit(1);
});
