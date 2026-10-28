import type {
  ProviderStreamHandlers,
  ProviderStreamRequest,
  ProviderStreamResult,
  ToolCall,
  Usage,
} from "./types.js";
import { asText, readErrorBody, readSse, trimSlash } from "./sse.js";

interface OpenAiToolCallAccum {
  id: string;
  name: string;
  args: string;
}

function convertMessages(system: string, messages: ProviderStreamRequest["messages"]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content || "(empty)" });
    } else if (m.role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant", content: m.content || null };
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments || "{}" },
        }));
      }
      out.push(entry);
    }
  }
  return out;
}

function usageFrom(raw: any): Usage {
  if (!raw || typeof raw !== "object") return { input: 0, output: 0 };
  return {
    input: Number(raw.prompt_tokens || raw.input_tokens || 0),
    output: Number(raw.completion_tokens || raw.output_tokens || 0),
    reasoning: Number(raw.completion_tokens_details?.reasoning_tokens || 0) || undefined,
    cacheRead: Number(raw.prompt_tokens_details?.cached_tokens || 0) || undefined,
  };
}

async function once(
  req: ProviderStreamRequest,
  handlers: ProviderStreamHandlers,
  includeUsageOption: boolean,
): Promise<ProviderStreamResult> {
  const url = `${trimSlash(req.baseUrl)}/chat/completions`;
  const body: Record<string, unknown> = {
    model: req.model,
    messages: convertMessages(req.system, req.messages),
    stream: true,
  };
  if (includeUsageOption) body.stream_options = { include_usage: true };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }
  if (req.temperature != null) body.temperature = req.temperature;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${req.apiKey || "none"}`,
      ...(req.headers || {}),
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!res.ok) {
    const detail = await readErrorBody(res);
    if (includeUsageOption && res.status === 400 && /stream_options|include_usage/i.test(detail)) {
      return once(req, handlers, false);
    }
    throw new Error(`${req.name} ${res.status}: ${detail.slice(0, 1200)}`);
  }

  let text = "";
  let reasoning = "";
  let finishReason = "";
  let usage: Usage = { input: 0, output: 0 };
  const toolAccums = new Map<number, OpenAiToolCallAccum>();

  const handleData = (data: string) => {
    if (!data || data === "[DONE]") return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    if (json.usage) usage = usageFrom(json.usage);
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || choice.message;
    if (!delta) return;
    const piece = asText(delta.content);
    if (piece) {
      text += piece;
      handlers.onText?.(piece);
    }
    const think =
      asText(delta.reasoning_content) ||
      asText(delta.reasoning) ||
      (Array.isArray(delta.reasoning_details)
        ? delta.reasoning_details.map((d: any) => d?.text || "").join("")
        : "");
    if (think) {
      reasoning += think;
      handlers.onReasoning?.(think);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = Number(tc.index ?? 0);
        const current = toolAccums.get(index) || { id: "", name: "", args: "" };
        if (tc.id) current.id = tc.id;
        if (tc.function?.name) current.name += tc.function.name;
        if (tc.function?.arguments) current.args += tc.function.arguments;
        toolAccums.set(index, current);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  await readSse(res, (_event, data) => handleData(data));

  const toolCalls: ToolCall[] = [...toolAccums.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, tc]) => tc.name)
    .map(([index, tc]) => ({
      id: tc.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.name,
      arguments: tc.args || "{}",
    }));

  return { text, reasoning, toolCalls, usage, finishReason };
}

export async function streamOpenAi(
  req: ProviderStreamRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderStreamResult> {
  return once(req, handlers, true);
}
