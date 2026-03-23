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

import { useCallback, useEffect, useState } from 'react';
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

const ACTIVE_CONV_KEY = 'ot_chat_active_conversation';

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
  // When project changes, reset chat and reload the conversation list.
  useEffect(() => {
    setConversationId(null);
    setMessages([]);
    localStorage.removeItem(ACTIVE_CONV_KEY);

    (async () => {
      const list = await listConversations(projectKey);
      setConversations(list);
    })();
  }, [projectKey]);

  const refreshList = useCallback(async () => {
    const list = await listConversations(projectKey);
    setConversations(list);
  }, [projectKey]);

  const startNewConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    localStorage.removeItem(ACTIVE_CONV_KEY);
  }, []);

  const switchConversation = useCallback(async (id: string) => {
    setLoadingConversation(true);
    try {
      const conv = await getConversation(id);
      if (conv) {
        setConversationId(conv.id);
        setMessages(conv.messages);
        localStorage.setItem(ACTIVE_CONV_KEY, conv.id);
      }
    } finally {
      setLoadingConversation(false);
    }
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      await deleteConv(id);
      if (conversationId === id) {
        setConversationId(null);
        setMessages([]);
        localStorage.removeItem(ACTIVE_CONV_KEY);
      }
      await refreshList();
    },
    [conversationId, refreshList],
  );

  const persistMessages = useCallback(
    async (msgs: ChatMessage[], provider: string, model: string) => {
      if (msgs.length === 0) return;

      let id = conversationId;
      const now = Date.now();

      if (!id) {
        id = generateId();
        setConversationId(id);
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
      localStorage.setItem(ACTIVE_CONV_KEY, id);
      await refreshList();
    },
    [conversationId, projectKey, refreshList],
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
