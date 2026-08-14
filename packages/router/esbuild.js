// Bundles the extension for the Extension Host. Unlike modelglass-router-examples
// (plain Node scripts run directly via tsx), a VS Code extension's `main` entry
// must be a single bundled file — the Extension Host doesn't run tsx/ts-node.
// `vscode` is external (provided by the host at runtime, must not be bundled).
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  // .cjs, not .js: package.json sets "type": "module" (for esbuild.js and the
  // test runner), but the bundle itself must load as CommonJS — the Extension
  // Host requires() `main`, and esbuild's CJS output (`exports.activate = ...`)
  // would fail under Node's ESM loader if left as a bare .js file under a
  // "type": "module" package. The explicit .cjs extension forces CommonJS
  // interpretation regardless of the package-level "type" setting.
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
