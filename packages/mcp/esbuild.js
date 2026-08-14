// Bundles the extension for the Extension Host. Mirrors packages/router's
// esbuild.js exactly (SCO-434 split) — see that file's header for why the
// output is .cjs despite "type": "module", and why `vscode` is external.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: !watch,
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("esbuild: watching for changes...");
} else {
  await build(options);
  console.log("esbuild: build complete -> dist/extension.cjs");
}
