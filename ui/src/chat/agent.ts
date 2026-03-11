import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { makeGraphTools } from "./tools";
import type { GraphStore } from "../store/types";

function createLLM(providerId: string, apiKey: string): BaseChatModel {
  switch (providerId) {
    case "anthropic":
      return new ChatAnthropic({
        model: "claude-sonnet-4-5-20250929",
        apiKey,
        clientOptions: { dangerouslyAllowBrowser: true },
      });
    case "openai":
      return new ChatOpenAI({ model: "gpt-4o-mini", apiKey });
    case "gemini":
      return new ChatGoogleGenerativeAI({ model: "gemini-2.0-flash", apiKey });
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

export function createChatAgent(
  providerId: string,
  apiKey: string,
  systemPrompt: string,
  store: GraphStore,
) {
  const llm = createLLM(providerId, apiKey);
  const tools = makeGraphTools(store);
  return createReactAgent({
    llm,
    tools,
    stateModifier: systemPrompt,
  });
}
