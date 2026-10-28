/**
 * Minimal SSE reader that works with fetch Response bodies on Node 20+.
 * Handles CRLF, multi-line data, and comment/keep-alive lines.
 */
export async function readSse(
  res: Response,
  onEvent: (event: string, data: string) => void,
): Promise<void> {
  if (!res.body) throw new Error("Response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (chunk: string) => {
    let event = "";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) onEvent(event, data.join("\n"));
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      flush(chunk);
      index = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer.replace(/\r\n/g, "\n"));
}

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      const message =
        json?.error?.message || json?.error?.detail || json?.message || json?.error || text;
      return typeof message === "string" ? message : JSON.stringify(message);
    } catch {
      return text;
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as any).text || "");
        return "";
      })
      .join("");
  }
  if (value && typeof value === "object" && "text" in value) return String((value as any).text || "");
  return "";
}
