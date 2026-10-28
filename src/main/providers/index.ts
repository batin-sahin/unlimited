import type { ProviderStreamHandlers, ProviderStreamRequest, ProviderStreamResult } from "./types.js";
import type { ProviderKind } from "../../shared/types.js";
import { streamAnthropic } from "./anthropic.js";
import { streamGoogle } from "./google.js";
import { streamOpenAi } from "./openai.js";

export function streamProvider(
  req: ProviderStreamRequest,
  handlers: ProviderStreamHandlers,
): Promise<ProviderStreamResult> {
  switch (req.kind as ProviderKind) {
    case "anthropic":
      return streamAnthropic(req, handlers);
    case "google":
      return streamGoogle(req, handlers);
    default:
      return streamOpenAi(req, handlers);
  }
}
