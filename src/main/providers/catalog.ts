import rawCatalog from "./catalog.json" with { type: "json" };
import type {
  CatalogMeta,
  CatalogModelMeta,
  CatalogProviderMeta,
  ProviderKind,
} from "../../shared/types.js";

/**
 * The provider catalog (models.dev, slimmed at build time by
 * scripts/fetch-catalog.mjs). Gives the wizards 100+ named providers:
 * each maps to one of the three wire protocols and a default endpoint.
 * The app ships with a committed catalog, so it works offline.
 */

interface CatalogFile extends CatalogMeta {
  providerCount: number;
  modelCount: number;
}

const CATALOG = rawCatalog as unknown as CatalogFile;

/** Well-known endpoints for providers whose catalog entry omits `api`. */
const BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  "fireworks-ai": "https://api.fireworks.ai/inference/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  nvidia: "https://integrate.api.nvidia.com/v1",
  perplexity: "https://api.perplexity.ai",
  cohere: "https://api.cohere.ai/compatibility/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  opencode: "https://opencode.ai/zen/v1",
  moonshotai: "https://api.moonshot.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
  minimax: "https://api.minimax.io/v1",
  alibaba: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "github-copilot": "https://api.githubcopilot.com",
  "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1",
  kilo: "https://api.kilo.ai/api/gateway",
  "kilo-code": "https://api.kilo.ai/api/gateway",
  "ai-gateway": "https://ai-gateway.vercel.sh/v1",
};

/** Derive the wire protocol: Google-family → google, Anthropic → anthropic, everything else speaks OpenAI. */
function kindFor(p: { id: string; npm?: string }): ProviderKind {
  if (p.id === "google" || p.id.startsWith("google-") || p.npm === "@ai-sdk/google") return "google";
  if (p.npm === "@ai-sdk/anthropic" || p.id === "anthropic") return "anthropic";
  return "openai";
}

let cached: CatalogProviderMeta[] | null = null;

/** All catalog providers with protocol + endpoint resolved (never undefined). */
export function catalogProviders(): CatalogProviderMeta[] {
  if (!cached) {
    cached = CATALOG.providers.map((p: any) => ({
      id: String(p.id),
      name: String(p.name || p.id),
      api: String(p.api || BASE_URLS[p.id] || ""),
      kind: kindFor(p),
      ...(p.doc ? { doc: String(p.doc) } : {}),
      models: Array.isArray(p.models)
        ? p.models.map(
            (m: any): CatalogModelMeta => ({
              id: String(m.id),
              name: String(m.name || m.id),
              ...(Number.isFinite(m.context) ? { context: Number(m.context) } : {}),
              ...(m.toolCall ? { toolCall: true } : {}),
            }),
          )
        : [],
    }));
  }
  return cached;
}

/** One provider by catalog id, or undefined. */
export function catalogProvider(id: string): CatalogProviderMeta | undefined {
  return catalogProviders().find((p) => p.id === id);
}

export function catalogStats(): { providers: number; models: number; generatedAt: string; source: string } {
  return {
    providers: CATALOG.providerCount,
    models: CATALOG.modelCount,
    generatedAt: CATALOG.generatedAt,
    source: CATALOG.source,
  };
}

/** Payload for the renderer's pickers (Bootstrap.catalog). */
export function catalogMeta(): CatalogMeta {
  return {
    generatedAt: CATALOG.generatedAt,
    source: CATALOG.source,
    providers: catalogProviders(),
  };
}
