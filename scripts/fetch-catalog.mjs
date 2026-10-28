#!/usr/bin/env node
/**
 * Downloads the models.dev catalog and writes a slim, bundled version to
 * src/main/providers/catalog.json. Runs at build time; the app also ships
 * with the generated file so it works offline (a failed fetch keeps the
 * existing catalog and the build continues).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "src", "main", "providers", "catalog.json");
const SOURCE = process.env.UNLIMITED_CATALOG_URL || "https://models.dev/api.json";

function slimModel(id, m) {
  const model = { id, name: m.name || id };
  if (m.reasoning) model.reasoning = true;
  if (m.tool_call) model.toolCall = true;
  const limit = m.limit || {};
  if (limit.context) model.context = limit.context;
  return model;
}

async function main() {
  console.log(`Fetching catalog from ${SOURCE} ...`);
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
  const raw = await res.json();

  const providers = [];
  let modelCount = 0;

  for (const [id, p] of Object.entries(raw)) {
    if (!p || typeof p !== "object") continue;
    const models = [];
    for (const [mid, m] of Object.entries(p.models || {})) {
      if (!m || typeof m !== "object") continue;
      models.push(slimModel(mid, m));
    }
    if (!models.length) continue;
    models.sort((a, b) => a.name.localeCompare(b.name));
    providers.push({
      id,
      name: p.name || id,
      ...(p.api ? { api: p.api } : {}),
      ...(p.doc ? { doc: p.doc } : {}),
      models,
    });
    modelCount += models.length;
  }

  providers.sort((a, b) => a.name.localeCompare(b.name));
  const catalog = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    providerCount: providers.length,
    modelCount,
    providers,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(catalog));
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`Wrote ${providers.length} providers / ${modelCount} models (${kb} KB) -> ${out}`);
}

main().catch((err) => {
  console.error(err.message);
  if (fs.existsSync(out)) {
    console.error("Keeping the existing catalog; build can continue offline.");
    process.exit(0);
  }
  process.exit(1);
});
