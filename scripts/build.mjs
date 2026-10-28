#!/usr/bin/env node
/** Bundles the Electron main/preload with esbuild. */
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  loader: { ".json": "json" },
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production") },
  external: ["electron"],
};

async function run() {
  if (target === "main") {
    await esbuild.build({
      ...common,
      entryPoints: [path.join(root, "src/main/index.ts")],
      outfile: path.join(root, "dist/main/index.cjs"),
    });
    await esbuild.build({
      ...common,
      entryPoints: [path.join(root, "src/preload/index.ts")],
      outfile: path.join(root, "dist/preload/index.cjs"),
    });
  } else {
    console.error("usage: node scripts/build.mjs main");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
