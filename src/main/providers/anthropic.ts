import type {
  ProviderStreamHandlers,
  ProviderStreamRequest,
  ProviderStreamResult,
  ToolCall,
  Usage,
} from "./types.js";
import { readErrorBody, readSse, trimSlash } from "./sse.js";

function convertMessages(messages: ProviderStreamRequest["messages"]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") continue;

    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content || "(empty)" }] });
      continue;
    }

    if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const call of m.toolCalls || []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }
      if (!content.length) content.push({ type: "text", text: "(empty)" });
      out.push({ role: "assistant", content });
      continue;
    }

    if (m.role === "tool") {
      // Claude requires all tool results for one assistant turn in a single user message.
      const blocks: unknown[] = [
        { type: "tool_result", tool_use_id: m.toolCallId, content: m.content || "(empty)" },
      ];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        const next = messages[j];
        blocks.push({
          type: "tool_result",
          tool_use_id: next.toolCallId,
          content: next.content || "(empty)",
        });
        j++;
      }
      out.push({ role: "user", content: blocks });
      i = j - 1;
    }
  }
  return out;
}

function usageFrom(input: any, output: any): Usage {
  return {
    input: Number(input?.input_tokens || 0),
    output: Number(output?.output_tokens || 0),
    cacheRead: Number(input?.cache_read_input_tokens || 0) || undefined,
  };
}

export async function streamAnthropic(
  req: ProviderStreamRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderStreamResult> {
  const url = `${trimSlash(req.baseUrl)}/messages`;
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: Math.min(req.maxTokens || 8192, 64_000),
    system: req.system,
    messages: convertMessages(req.messages),
    stream: true,
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (req.temperature != null) body.temperature = req.temperature;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": req.apiKey,
      Authorization: `Bearer ${req.apiKey}`,
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
  const toolsAccum = new Map<number, { id: string; name: string; json: string }>();
  let currentBlock: number | null = null;

  await readSse(res, (_event, data) => {
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    switch (json.type) {
      case "message_start": {
        usage = { ...usage, ...usageFrom(json.message?.usage, json.message?.usage) };
        break;
      }
      case "content_block_start": {
        currentBlock = Number(json.index ?? 0);
        const block = json.content_block;
        if (block?.type === "tool_use") {
          toolsAccum.set(currentBlock, { id: block.id, name: block.name, json: "" });
        }
        break;
      }
      case "content_block_delta": {
        const delta = json.delta;
        if (delta?.type === "text_delta") {
          text += delta.text || "";
          handlers.onText?.(delta.text || "");
        } else if (delta?.type === "thinking_delta") {
          reasoning += delta.thinking || "";
          handlers.onReasoning?.(delta.thinking || "");
        } else if (delta?.type === "input_json_delta" && currentBlock != null) {
          const accum = toolsAccum.get(currentBlock);
          if (accum) accum.json += delta.partial_json || "";
        }
        break;
      }
      case "message_delta": {
        if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
        if (json.usage) usage = { ...usage, ...usageFrom({ input_tokens: usage.input }, json.usage) };
        break;
      }
      case "error": {
        throw new Error(json.error?.message || "Anthropic stream error");
      }
    }
  });

  const toolCalls: ToolCall[] = [...toolsAccum.entries()].map(([index, accum]) => ({
    id: accum.id || `tool_${index}`,
    name: accum.name,
    arguments: accum.json || "{}",
  }));

  return { text, reasoning, toolCalls, usage, finishReason };
}
