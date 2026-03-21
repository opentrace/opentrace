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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ChatThought from './ChatThought';
import ChatToolCall from './ChatToolCall';
import { markdownComponents } from './markdownComponents';
import type { ChatMessage, ChatToolConfig } from './types';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  tools?: Record<string, ChatToolConfig>;
}

export default function ChatMessages({ messages, streaming, tools }: Props) {
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
      {messages.map((msg, i) => {
        switch (msg.type) {
          case 'user':
            return (
              <div key={i} className="message user">
                <div className="message-content">{msg.content}</div>
              </div>
            );
          case 'text':
            return (
              <div
                key={i}
                className="message ai"
                {...(!streaming && i === messages.length - 1
                  ? { 'data-testid': 'chat-response-done' }
                  : {})}
              >
                <div className="message-content">
                  <div className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {msg.content}
                    </ReactMarkdown>
                    {streaming && i === messages.length - 1 && (
                      <span className="streaming-cursor" />
                    )}
                  </div>
                </div>
              </div>
            );
          case 'thought':
            return (
              <div key={i} className="message ai">
                <div className="message-content">
                  <ChatThought content={msg.content} />
                </div>
              </div>
            );
          case 'tool_call':
            return (
              <div key={msg.id} className="message ai">
                <div className="message-content">
                  <ChatToolCall part={msg} config={tools?.[msg.name]} />
                </div>
              </div>
            );
        }
      })}
    </div>
  );
}
