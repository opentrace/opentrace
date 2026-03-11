export type { ChatMessage, UserMessage, AssistantMessage, MessagePart } from "./types";

export interface ProviderInfo {
  name: string;
  id: string;
}

const anthropic: ProviderInfo = { name: "Anthropic Claude", id: "anthropic" };
const openai: ProviderInfo = { name: "OpenAI", id: "openai" };
const gemini: ProviderInfo = { name: "Google Gemini", id: "gemini" };

export const PROVIDERS: Record<string, ProviderInfo> = { anthropic, openai, gemini };

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>;
