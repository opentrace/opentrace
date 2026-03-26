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
import type { ImageAttachment } from '../components/chat/types';

// Re-export types so existing consumers don't need to change imports
export type { Conversation, ConversationSummary, ChatHistoryStore };

const DB_NAME = 'opentrace_chat';
const DB_VERSION = 3;
const STORE_NAME = 'conversations';
const BLOB_STORE = 'image_blobs';

interface StoredBlob {
  /** Same as ImageAttachment.id */
  id: string;
  conversationId: string;
  dataUrl: string;
}

/** Placeholder used when the blob is missing (deleted externally, etc.) */
const MISSING_IMAGE_PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60">' +
      '<rect width="60" height="60" fill="#333" rx="6"/>' +
      '<text x="30" y="34" text-anchor="middle" fill="#888" font-size="11">?</text>' +
      '</svg>',
  );

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
          // v3: separate blob store for image attachments
          if (oldVersion < 3) {
            if (!db.objectStoreNames.contains(BLOB_STORE)) {
              const blobStore = db.createObjectStore(BLOB_STORE, {
                keyPath: 'id',
              });
              blobStore.createIndex('conversationId', 'conversationId');
            }

            // Migrate existing inline images to blob store
            if (oldVersion >= 1) {
              const convStore = transaction.objectStore(STORE_NAME);
              convStore.getAll().then((convs: Conversation[]) => {
                const blobSt = transaction.objectStore(BLOB_STORE);
                for (const conv of convs) {
                  let changed = false;
                  for (const msg of conv.messages) {
                    if (msg.role === 'user' && msg.images) {
                      for (const img of msg.images) {
                        if (img.dataUrl && img.dataUrl.length > 0) {
                          blobSt.put({
                            id: img.id,
                            conversationId: conv.id,
                            dataUrl: img.dataUrl,
                          } satisfies StoredBlob);
                          img.dataUrl = '';
                          changed = true;
                        }
                      }
                    }
                  }
                  if (changed) convStore.put(conv);
                }
              });
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

  /**
   * Extract image dataUrls from messages, store them as blobs,
   * and replace inline dataUrls with empty strings.
   */
  private async saveBlobs(
    db: IDBPDatabase,
    convId: string,
    messages: ChatMessage[],
  ): Promise<ChatMessage[]> {
    const blobs: StoredBlob[] = [];
    const stripped = messages.map((m) => {
      if (m.role !== 'user' || !m.images?.length) return m;
      return {
        ...m,
        images: m.images.map((img) => {
          if (img.dataUrl) {
            blobs.push({
              id: img.id,
              conversationId: convId,
              dataUrl: img.dataUrl,
            });
          }
          return { ...img, dataUrl: '' };
        }),
      };
    });

    if (blobs.length > 0) {
      const tx = db.transaction(BLOB_STORE, 'readwrite');
      const store = tx.objectStore(BLOB_STORE);
      await Promise.all([...blobs.map((b) => store.put(b)), tx.done]);
    }

    return stripped;
  }

  /**
   * Re-hydrate image dataUrls from the blob store into messages.
   */
  private async hydrateBlobs(
    db: IDBPDatabase,
    messages: ChatMessage[],
  ): Promise<ChatMessage[]> {
    // Collect all image IDs that need hydrating
    const imageIds: string[] = [];
    for (const m of messages) {
      if (m.role === 'user' && m.images) {
        for (const img of m.images) {
          if (!img.dataUrl) imageIds.push(img.id);
        }
      }
    }
    if (imageIds.length === 0) return messages;

    // Batch-read blobs
    const tx = db.transaction(BLOB_STORE, 'readonly');
    const store = tx.objectStore(BLOB_STORE);
    const blobResults = await Promise.all(
      imageIds.map((id) => store.get(id) as Promise<StoredBlob | undefined>),
    );
    const blobMap = new Map<string, string>();
    for (const blob of blobResults) {
      if (blob) blobMap.set(blob.id, blob.dataUrl);
    }

    return messages.map((m) => {
      if (m.role !== 'user' || !m.images?.length) return m;
      return {
        ...m,
        images: m.images.map((img): ImageAttachment => {
          if (img.dataUrl) return img;
          return {
            ...img,
            dataUrl: blobMap.get(img.id) ?? MISSING_IMAGE_PLACEHOLDER,
          };
        }),
      };
    });
  }

  async save(conv: Conversation): Promise<void> {
    const db = await this.getDB();
    const strippedMessages = await this.saveBlobs(db, conv.id, conv.messages);
    await db.put(STORE_NAME, { ...conv, messages: strippedMessages });
  }

  async get(id: string): Promise<Conversation | undefined> {
    const db = await this.getDB();
    const conv = await db.get(STORE_NAME, id);
    if (!conv) return undefined;
    conv.messages = await this.hydrateBlobs(db, conv.messages);
    return conv;
  }

  async delete(id: string): Promise<void> {
    const db = await this.getDB();
    // Delete associated blobs first
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    const blobStore = tx.objectStore(BLOB_STORE);
    const idx = blobStore.index('conversationId');
    let cursor = await idx.openCursor(id);
    while (cursor) {
      cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
    // Then delete the conversation itself
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
