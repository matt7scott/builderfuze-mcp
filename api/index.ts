/**
 * Vercel serverless entrypoint.
 *
 * Vercel routes all incoming HTTP to this file (per vercel.json rewrites).
 * We export the Express app as the default export; Vercel's @vercel/node
 * runtime adapts Express request handling to serverless invocations.
 */

import { createApp } from "../src/app.js";

export default createApp();
