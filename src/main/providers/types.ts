/** Chat/turn primitives shared by all provider clients. */

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Usage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** For role "tool". */
  toolCallId?: string;
  /** For role "tool" (Google needs the tool name). */
  toolName?: string;
  /** For role "assistant". */
  toolCalls?: ToolCall[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderStreamRequest {
  kind: "openai" | "anthropic" | "google";
  /** Human name for error messages. */
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface ProviderStreamHandlers {
  onText?: (piece: string) => void;
  onReasoning?: (piece: string) => void;
}

export interface ProviderStreamResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string;
}
