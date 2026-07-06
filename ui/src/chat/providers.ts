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
  defaultModel: 'claude-opus-4-8',
  models: [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  ],
};

const openai: ProviderInfo = {
  name: 'OpenAI',
  id: 'openai',
  defaultModel: 'gpt-5.4-mini',
  models: [
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  ],
};

const gemini: ProviderInfo = {
  name: 'Google Gemini',
  id: 'gemini',
  defaultModel: 'gemini-3.5-flash',
  models: [
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
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

/**
 * Fallback provider used when a persisted choice (`localStorage`) doesn't
 * match any current `PROVIDERS` key — e.g. after a rename/removal across
 * builds. Must always be a key of `PROVIDERS`. See `loadProviderChoice`
 * in `chat/storage.ts` (Fix #3).
 */
export const DEFAULT_PROVIDER_ID = 'anthropic';

/**
 * Infer the provider from the shape of an API key so the user can just
 * paste a key instead of picking a provider first.
 *
 * Prefixes are stable and provider-specific:
 *   - Anthropic  → `sk-ant-…`
 *   - OpenAI     → `sk-…` / `sk-proj-…` (checked AFTER Anthropic, since
 *                  both begin with `sk-`)
 *   - Gemini     → Google API keys are `AIza` + 35 url-safe chars
 *
 * Returns the matching provider id, or `null` when the format isn't
 * recognized — callers fall back to a manual picker. Never matches the
 * `local` provider: local models have no detectable key (the key is
 * optional), so local stays an explicit choice.
 */
export function detectProvider(key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (/^AIza[0-9A-Za-z_-]{35}$/.test(k)) return 'gemini';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}

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
