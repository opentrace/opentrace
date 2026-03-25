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

import type { ChatMessage } from './providers';

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
  /** Scopes the conversation to a project (typically the repo URL) */
  projectKey: string;
  messages: ChatMessage[];
}

export type ConversationSummary = Omit<Conversation, 'messages'>;

/**
 * Persistence layer for chat conversations.
 *
 * Implement this interface to swap the storage backend
 * (e.g. IndexedDB, REST API, SQLite, etc.).
 */
export interface ChatHistoryStore {
  save(conv: Conversation): Promise<void>;
  get(id: string): Promise<Conversation | undefined>;
  delete(id: string): Promise<void>;
  list(projectKey?: string): Promise<ConversationSummary[]>;
}
