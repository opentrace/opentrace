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

/**
 * @opentrace/components/chat — Reusable AI chat panel.
 *
 * Usage:
 *   import { ChatPanel } from '@opentrace/components/chat';
 */

// ─── Main component ─────────────────────────────────────────────────────
export { default as ChatPanel } from './ChatPanel';

// ─── Types ──────────────────────────────────────────────────────────────
export type {
  ChatMessage,
  UserMessage,
  AssistantMessage,
  MessagePart,
  TextPart,
  ThoughtPart,
  ToolCallPart,
  ChatAgentHandle,
  ChatTemplate,
  ChatTab,
  ChatPanelProps,
} from './types';

// ─── Providers & storage ────────────────────────────────────────────────
export { PROVIDERS, PROVIDER_IDS, API_KEY_RESOURCES } from './providers';
export type { ProviderInfo, ModelInfo, ApiKeyResource } from './providers';

export {
  loadApiKey,
  saveApiKey,
  loadProviderChoice,
  saveProviderChoice,
  loadModelChoice,
  saveModelChoice,
  loadLocalUrl,
  saveLocalUrl,
} from './storage';

// ─── Hooks ──────────────────────────────────────────────────────────────
export { useChatAgent } from './useChatAgent';
export { useResizablePanel } from './useResizablePanel';

// ─── Sub-components (for advanced composition) ──────────────────────────
export { default as ChatSettings } from './ChatSettings';
export { default as ChatMessages } from './ChatMessages';
export { default as ChatInput } from './ChatInput';
export { default as ChatParts } from './ChatParts';
export { default as ChatThought } from './ChatThought';
export { default as ChatToolCall } from './ChatToolCall';
export { default as ChatTemplates } from './ChatTemplates';
export { markdownComponents } from './markdownComponents';
