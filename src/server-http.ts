/**
 * Local dev entrypoint — boots the Express app as a long-lived process.
 *
 *   npm run dev:http      — http://localhost:3001
 *
 * In production, Vercel imports the app directly from src/app.ts via
 * api/index.ts. This file is only run locally.
 */

import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);
const app = createApp();

app.listen(PORT, () => {
  console.log(`builderfuze-mcp HTTP server ready at http://localhost:${PORT}/mcp`);
  console.log(`  auth required: ${process.env.MCP_REQUIRE_AUTH !== "false"}`);
  console.log(
    `  BuilderFuze API: ${process.env.BUILDERFUZE_API_URL ?? "https://builderfuze.vercel.app"}`
  );
});
