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

import { openDB, type IDBPDatabase } from 'idb';
import type { ChatMessage } from './providers';

const DB_NAME = 'opentrace_chat';
const DB_VERSION = 2;
const STORE_NAME = 'conversations';

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

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('projectKey', 'projectKey');
        } else if (oldVersion < 2) {
          const store = transaction.objectStore(STORE_NAME);
          if (!store.indexNames.contains('projectKey')) {
            store.createIndex('projectKey', 'projectKey');
          }
        }
      },
    });
  }
  return dbPromise;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function titleFromFirstMessage(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New conversation';
  const text = first.content.trim();
  if (text.length <= 50) return text;
  return text.slice(0, 47) + '...';
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const db = await getDB();
  await db.put(STORE_NAME, conv);
}

export async function getConversation(
  id: string,
): Promise<Conversation | undefined> {
  const db = await getDB();
  return db.get(STORE_NAME, id);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
}

export async function listConversations(
  projectKey?: string,
): Promise<ConversationSummary[]> {
  const db = await getDB();
  let all: Conversation[];
  if (projectKey) {
    all = await db.getAllFromIndex(STORE_NAME, 'projectKey', projectKey);
  } else {
    all = await db.getAll(STORE_NAME);
  }
  // Return newest first, without messages to keep it lightweight
  return all
    .map(({ messages: _, ...summary }) => summary) // eslint-disable-line @typescript-eslint/no-unused-vars
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
