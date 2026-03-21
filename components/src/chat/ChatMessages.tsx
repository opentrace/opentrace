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

import { useEffect, useRef } from 'react';
import ChatParts from './ChatParts';
import ChatTemplates from './ChatTemplates';
import type {
  ChatMessage,
  AssistantMessage,
  ChatTemplate,
  ChatToolConfig,
} from './types';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  templates: ChatTemplate[];
  tools?: Record<string, ChatToolConfig>;
  onTemplate: (prompt: string) => void;
}

export default function ChatMessages({
  messages,
  streaming,
  templates,
  tools,
  onTemplate,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 80;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  useEffect(() => {
    if (isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="messages" ref={scrollRef} onScroll={handleScroll}>
      {messages.length === 0 && (
        <div className="empty-chat">
          <p>Ask me anything about your graph!</p>
          <ChatTemplates templates={templates} onSelect={onTemplate} />
        </div>
      )}
      {messages.map((m, i) => (
        <div
          key={i}
          className={`message ${m.role === 'user' ? 'user' : 'ai'}`}
          {...(m.role === 'assistant' && i === messages.length - 1 && !streaming
            ? { 'data-testid': 'chat-response-done' }
            : {})}
        >
          <div className="message-content">
            {m.role === 'assistant' ? (
              <ChatParts
                parts={(m as AssistantMessage).parts}
                streaming={streaming && i === messages.length - 1}
                tools={tools}
              />
            ) : (
              m.content
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
