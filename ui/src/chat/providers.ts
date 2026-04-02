/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type {
  ChatMessage,
  UserMessage,
  AssistantMessage,
  MessagePart,
  TokenUsage,
} from '@opentrace/components/chat';

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
  defaultModel: 'claude-sonnet-4-6',
  models: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-opus-4-5-20250529', name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  ],
};

const openai: ProviderInfo = {
  name: 'OpenAI',
  id: 'openai',
  defaultModel: 'gpt-4.1-mini',
  models: [
    { id: 'o3', name: 'o3' },
    { id: 'o4-mini', name: 'o4-mini' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
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
  gemini,
  anthropic,
  openai,
  local,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Array<
  keyof typeof PROVIDERS
>;

export interface ApiKeyResource {
  docs: string;
  dashboard: string;
  signup: string;
  signupLabel: string;
  steps: string[];
}

export const API_KEY_RESOURCES: Record<string, ApiKeyResource> = {
  openai: {
    docs: 'https://platform.openai.com/docs/quickstart',
    dashboard: 'https://platform.openai.com/api-keys',
    signup: 'https://platform.openai.com/api-keys',
    signupLabel: 'platform.openai.com',
    steps: [
      'Go to API Keys in your dashboard',
      'Click "Create new secret key"',
    ],
  },
  anthropic: {
    docs: 'https://docs.anthropic.com/claude/docs/getting-access-to-claude',
    dashboard: 'https://platform.claude.com/settings/keys',
    signup: 'https://platform.claude.com/settings/keys',
    signupLabel: 'platform.claude.com',
    steps: ['Go to Settings > API Keys', 'Click "Create Key"'],
  },
  gemini: {
    docs: 'https://ai.google.dev/gemini-api/docs/api-key',
    dashboard: 'https://aistudio.google.com/api-keys',
    signup: 'https://aistudio.google.com/api-keys',
    signupLabel: 'Google AI Studio',
    steps: [
      'Click "Get API key"',
      'Create a key for your project',
      'Free tier available — no billing required',
    ],
  },
};
