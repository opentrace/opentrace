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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ImageAttachment {
  kind: 'image';
  id: string;
  dataUrl: string;
  mimeType: string;
  name?: string;
}

export interface FileAttachment {
  kind: 'file';
  id: string;
  textContent: string;
  mimeType: string;
  name: string;
}

export type Attachment = ImageAttachment | FileAttachment;

export interface UserMessage {
  role: 'user';
  content: string;
  images?: ImageAttachment[];
  attachments?: Attachment[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  parts: MessagePart[];
  usage?: TokenUsage;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface PRReviewComment {
  body: string;
  path?: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
}
