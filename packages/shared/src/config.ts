/**
 * SCO-434 — extracted from the router package's lib.ts during the
 * router/mcp split, since auth.ts (also here) depends on it and both
 * packages need it. The router package re-exports this from its own
 * lib.ts so every existing `from "./lib.js"` import site there keeps
 * working unchanged.
 */
export const MODELGLASS_API =
  process.env.MODELGLASS_API ?? "https://modelglass-api.vercel.app";
