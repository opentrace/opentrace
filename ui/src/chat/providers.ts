export type {
  ChatMessage,
  UserMessage,
  AssistantMessage,
  MessagePart,
} from './types';

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ProviderInfo {
  name: string;
  id: string;
  models: ModelInfo[];
  defaultModel: string;
}

const anthropic: ProviderInfo = {
  name: 'Anthropic Claude',
  id: 'anthropic',
  defaultModel: 'claude-sonnet-4-5-20250929',
  models: [
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5' },
  ],
};

const openai: ProviderInfo = {
  name: 'OpenAI',
  id: 'openai',
  defaultModel: 'gpt-4o-mini',
  models: [
    { id: 'o3', name: 'o3' },
    { id: 'o4-mini', name: 'o4-mini' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
  ],
};

const gemini: ProviderInfo = {
  name: 'Google Gemini',
  id: 'gemini',
  defaultModel: 'gemini-2.5-flash',
  models: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  ],
};

const local: ProviderInfo = {
  name: 'Local LLM',
  id: 'local',
  defaultModel: 'llama3.2',
  models: [], // dynamic — user enters model name as free text
};

export const PROVIDERS: Record<string, ProviderInfo> = {
  anthropic,
  openai,
  gemini,
  local,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Array<
  keyof typeof PROVIDERS
>;
