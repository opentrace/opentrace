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

import type { ReactNode } from 'react';

/** Structured parts within an assistant message */

export interface TextPart {
  type: 'text';
  content: string;
}

export interface ThoughtPart {
  type: 'thought';
  content: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  args: string;
  result?: string;
  status: 'active' | 'success' | 'error';
  startTime: number;
  endTime?: number;
  /** Progress steps reported by sub-agents while running */
  progressSteps?: string[];
}

export type MessagePart = TextPart | ThoughtPart | ToolCallPart;

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  parts: MessagePart[];
}

export type ChatMessage = UserMessage | AssistantMessage;

/** Minimal contract between app and library for agent interaction */
export interface ChatAgentHandle {
  agent: {
    stream(input: unknown, config: unknown): AsyncIterable<unknown>;
  };
  progress: {
    setListener(fn: ((name: string, step: string) => void) | null): void;
  };
}

/** Template prompt for the empty-state grid */
export interface ChatTemplate {
  label: string;
  description: string;
  prompt: string;
}

/** Extra tab beyond the default "Chat" tab */
export interface ChatTab {
  id: string;
  label: string;
  render: () => ReactNode;
}

/** Props for the generic ChatPanel */
export interface ChatPanelProps {
  onClose: () => void;
  createAgent: (
    providerId: string,
    modelId: string,
    apiKey: string,
    baseUrl?: string,
  ) => ChatAgentHandle;
  title?: string;
  templates?: ChatTemplate[];
  toolNames?: Record<string, string>;
  agentTools?: Set<string>;
  renderToolResult?: (
    name: string,
    args: string,
    result: string,
  ) => ReactNode | null;
  tabs?: ChatTab[];
  onNodeSelect?: (nodeId: string) => void;
  onWidthChange?: (width: number) => void;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey?: string;
}
