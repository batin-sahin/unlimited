import type {
  ProviderStreamHandlers,
  ProviderStreamRequest,
  ProviderStreamResult,
  ToolCall,
  Usage,
} from "./types.js";
import { readErrorBody, readSse, trimSlash } from "./sse.js";

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function convertContents(messages: ProviderStreamRequest["messages"]): unknown[] {
  const contents: any[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content || "(empty)" }] });
      continue;
    }

    if (m.role === "assistant") {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls || []) {
        parts.push({ functionCall: { name: call.name, args: parseArgs(call.arguments) } });
      }
      if (!parts.length) parts.push({ text: "(empty)" });
      contents.push({ role: "model", parts });
      continue;
    }

    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.toolName || "tool",
              response: { result: m.content || "(empty)" },
            },
          },
        ],
      });
    }
  }

  return contents;
}

function usageFrom(raw: any): Usage {
  if (!raw) return { input: 0, output: 0 };
  return {
    input: Number(raw.promptTokenCount || 0),
    output: Number(raw.candidatesTokenCount || 0),
    reasoning: Number(raw.thoughtsTokenCount || 0) || undefined,
    cacheRead: Number(raw.cachedContentTokenCount || 0) || undefined,
  };
}

export async function streamGoogle(
  req: ProviderStreamRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderStreamResult> {
  const base = trimSlash(req.baseUrl);
  const model = req.model.replace(/^models\//, "");
  const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  const body: Record<string, unknown> = {
    contents: convertContents(req.messages),
    systemInstruction: { parts: [{ text: req.system }] },
  };
  if (req.tools.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }
  if (req.temperature != null) {
    body.generationConfig = { temperature: req.temperature };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": req.apiKey,
      ...(req.headers || {}),
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) {
    const detail = await readErrorBody(res);
    throw new Error(`${req.name} ${res.status}: ${detail.slice(0, 1200)}`);
  }

  let text = "";
  let reasoning = "";
  let finishReason = "";
  let usage: Usage = { input: 0, output: 0 };
  const toolCalls: ToolCall[] = [];

  await readSse(res, (_event, data) => {
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.usageMetadata) usage = usageFrom(json.usageMetadata);
    const candidate = json.candidates?.[0];
    if (!candidate) return;
    if (candidate.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === "string" && part.text) {
        if (part.thought) {
          reasoning += part.text;
          handlers.onReasoning?.(part.text);
        } else {
          text += part.text;
          handlers.onText?.(part.text);
        }
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `google_${toolCalls.length}_${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name || "tool",
          arguments: JSON.stringify(part.functionCall.args || {}),
        });
      }
    }
  });

  return { text, reasoning, toolCalls, usage, finishReason };
}
