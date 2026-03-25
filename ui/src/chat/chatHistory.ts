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
import type {
  ChatHistoryStore,
  Conversation,
  ConversationSummary,
} from './chatHistoryStore';
import type { ChatMessage } from './providers';

// Re-export types so existing consumers don't need to change imports
export type { Conversation, ConversationSummary, ChatHistoryStore };

const DB_NAME = 'opentrace_chat';
const DB_VERSION = 2;
const STORE_NAME = 'conversations';

export function generateId(): string {
  return crypto.randomUUID();
}

export function titleFromFirstMessage(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New conversation';
  // Use only the first line, strip markdown formatting
  const text = first.content
    .trim()
    .split('\n')[0]
    .replace(/[#*_`~>]/g, '');
  if (text.length <= 50) return text || 'New conversation';
  return text.slice(0, 47) + '...';
}

/**
 * IndexedDB-backed implementation of ChatHistoryStore.
 * Stores conversations entirely in the user's browser.
 */
export class IDBChatHistoryStore implements ChatHistoryStore {
  private dbPromise: Promise<IDBPDatabase> | null = null;

  private getDB(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(DB_NAME, DB_VERSION, {
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
      }).catch((err) => {
        this.dbPromise = null;
        throw err;
      });
    }
    return this.dbPromise;
  }

  async save(conv: Conversation): Promise<void> {
    const db = await this.getDB();
    await db.put(STORE_NAME, conv);
  }

  async get(id: string): Promise<Conversation | undefined> {
    const db = await this.getDB();
    return db.get(STORE_NAME, id);
  }

  async delete(id: string): Promise<void> {
    const db = await this.getDB();
    await db.delete(STORE_NAME, id);
  }

  async list(projectKey?: string): Promise<ConversationSummary[]> {
    const db = await this.getDB();
    let all: Conversation[];
    if (projectKey) {
      all = await db.getAllFromIndex(STORE_NAME, 'projectKey', projectKey);
    } else {
      all = await db.getAll(STORE_NAME);
    }
    return all
      .map(({ messages: _, ...summary }) => summary) // eslint-disable-line @typescript-eslint/no-unused-vars
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** Default store instance — swap this to change the persistence layer. */
let activeStore: ChatHistoryStore = new IDBChatHistoryStore();

export function getChatHistoryStore(): ChatHistoryStore {
  return activeStore;
}

export function setChatHistoryStore(store: ChatHistoryStore): void {
  activeStore = store;
}

// Convenience functions that delegate to the active store.
// These preserve the existing API so consumers don't need to change.
export async function saveConversation(conv: Conversation): Promise<void> {
  return activeStore.save(conv);
}

export async function getConversation(
  id: string,
): Promise<Conversation | undefined> {
  return activeStore.get(id);
}

export async function deleteConversation(id: string): Promise<void> {
  return activeStore.delete(id);
}

export async function listConversations(
  projectKey?: string,
): Promise<ConversationSummary[]> {
  return activeStore.list(projectKey);
}
