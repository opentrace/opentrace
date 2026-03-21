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

/** Flat message types — each message in the list is one renderable unit */

export interface UserMessage {
  type: 'user';
  content: string;
}

export interface TextMessage {
  type: 'text';
  content: string;
}

export interface ThoughtMessage {
  type: 'thought';
  content: string;
}

export interface ToolCallMessage {
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

export type ChatMessage =
  | UserMessage
  | TextMessage
  | ThoughtMessage
  | ToolCallMessage;

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

/** Per-tool display configuration */
export interface ChatToolConfig {
  /** Human-readable name shown in the tool call header */
  displayName: string;
  /** Whether this tool is a sub-agent (sparkle icon, markdown result, "Thinking" status) */
  isAgent?: boolean;
  /** Custom result renderer — return null to fall back to raw JSON */
  renderResult?: (args: string, result: string) => ReactNode | null;
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
  /** Tool display config keyed by tool name */
  tools?: Record<string, ChatToolConfig>;
  tabs?: ChatTab[];
  onNodeSelect?: (nodeId: string) => void;
  onWidthChange?: (width: number) => void;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey?: string;
}
