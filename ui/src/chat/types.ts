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
