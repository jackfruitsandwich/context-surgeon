import type { ProviderCodec } from "../contracts/provider.js";
import type { ProviderKind } from "../contracts/truth.js";
import { AnthropicMessagesCodec } from "./anthropic-messages.js";
import { OpenAIChatCompletionsCodec } from "./openai-chat-completions.js";
import { OpenAIResponsesCodec } from "./openai-responses.js";

const codecs: Readonly<Record<ProviderKind, ProviderCodec>> = Object.freeze({
  "openai-responses": new OpenAIResponsesCodec(),
  "openai-chat-completions": new OpenAIChatCompletionsCodec(),
  "anthropic-messages": new AnthropicMessagesCodec(),
});

export function providerCodec(provider: ProviderKind): ProviderCodec {
  return codecs[provider];
}

export {
  AnthropicMessagesCodec,
  OpenAIChatCompletionsCodec,
  OpenAIResponsesCodec,
};
