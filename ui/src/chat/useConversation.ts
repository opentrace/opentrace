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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from './providers';
import {
  type Conversation,
  type ConversationSummary,
  generateId,
  getConversation,
  listConversations,
  saveConversation,
  deleteConversation as deleteConv,
  titleFromFirstMessage,
} from './chatHistory';

export interface UseConversationReturn {
  conversationId: string | null;
  conversations: ConversationSummary[];
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  startNewConversation: () => void;
  switchConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  /** Call after a completed assistant turn to persist */
  persistMessages: (
    msgs: ChatMessage[],
    provider: string,
    model: string,
  ) => Promise<void>;
  loadingConversation: boolean;
}

export function useConversation(projectKey?: string): UseConversationReturn {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingConversation, setLoadingConversation] = useState(false);

  // Ref to track the live conversation ID — avoids stale closures in callbacks
  const conversationIdRef = useRef<string | null>(null);
  // Cancel token for switchConversation to prevent race conditions
  const switchTokenRef = useRef(0);

  // When project changes, reset chat and reload the conversation list.
  useEffect(() => {
    let cancelled = false;

    setConversationId(null);
    conversationIdRef.current = null;
    setMessages([]);

    (async () => {
      const list = await listConversations(projectKey);
      if (!cancelled) {
        setConversations(list);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectKey]);

  const refreshList = useCallback(async () => {
    const list = await listConversations(projectKey);
    setConversations(list);
  }, [projectKey]);

  const startNewConversation = useCallback(() => {
    setConversationId(null);
    conversationIdRef.current = null;
    setMessages([]);
  }, []);

  const switchConversation = useCallback(async (id: string) => {
    const token = ++switchTokenRef.current;
    setLoadingConversation(true);
    try {
      const conv = await getConversation(id);
      // Only apply if this is still the most recent switch request
      if (token !== switchTokenRef.current) return;
      if (conv) {
        setConversationId(conv.id);
        conversationIdRef.current = conv.id;
        setMessages(conv.messages);
      }
    } finally {
      if (token === switchTokenRef.current) {
        setLoadingConversation(false);
      }
    }
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      await deleteConv(id);
      if (conversationIdRef.current === id) {
        setConversationId(null);
        conversationIdRef.current = null;
        setMessages([]);
      }
      await refreshList();
    },
    [refreshList],
  );

  const persistMessages = useCallback(
    async (msgs: ChatMessage[], provider: string, model: string) => {
      if (msgs.length === 0) return;

      // Use the ref to get the live ID, not the stale closure value
      let id = conversationIdRef.current;
      const now = Date.now();

      if (!id) {
        id = generateId();
        setConversationId(id);
        conversationIdRef.current = id;
      }

      const conv: Conversation = {
        id,
        title: titleFromFirstMessage(msgs),
        createdAt: now,
        updatedAt: now,
        provider,
        model,
        projectKey: projectKey ?? '',
        messages: msgs,
      };

      // Preserve original createdAt if conversation already exists
      const existing = await getConversation(id);
      if (existing) {
        conv.createdAt = existing.createdAt;
      }

      await saveConversation(conv);
      await refreshList();
    },
    [projectKey, refreshList],
  );

  return {
    conversationId,
    conversations,
    messages,
    setMessages,
    startNewConversation,
    switchConversation,
    deleteConversation,
    persistMessages,
    loadingConversation,
  };
}
