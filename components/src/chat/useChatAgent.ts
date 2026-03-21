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
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { ChatMessage, ToolCallMessage, ChatAgentHandle } from './types';

interface UseChatAgentOptions {
  getAgentHandle: () => ChatAgentHandle;
}

/** Build LangChain message history from a flat message list.
 *  Groups consecutive non-user messages into a single AIMessage. */
function toLangChainMessages(messages: ChatMessage[]) {
  const result: (HumanMessage | AIMessage)[] = [];
  let aiBuffer = '';

  const flushAI = () => {
    if (aiBuffer) {
      result.push(new AIMessage(aiBuffer));
      aiBuffer = '';
    }
  };

  for (const msg of messages) {
    if (msg.type === 'user') {
      flushAI();
      result.push(new HumanMessage(msg.content));
    } else if (msg.type === 'text') {
      aiBuffer += msg.content;
    }
    // thoughts and tool calls don't contribute to LangChain history
  }
  flushAI();
  return result;
}

export function useChatAgent({ getAgentHandle }: UseChatAgentOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel in-flight request on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  /** Append a new message to the list */
  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  /** Update the last message of a given type, or append if not found */
  const updateLast = useCallback(
    <T extends ChatMessage>(
      type: T['type'],
      updater: (msg: T) => T,
    ) => {
      setMessages((prev) => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].type === type) {
            updated[i] = updater(updated[i] as T);
            return updated;
          }
        }
        return prev;
      });
    },
    [],
  );

  /** Update a specific tool call message by ID */
  const updateToolCall = useCallback(
    (id: string, updater: (msg: ToolCallMessage) => ToolCallMessage) => {
      setMessages((prev) => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i--) {
          const msg = updated[i];
          if (msg.type === 'tool_call' && msg.id === id) {
            updated[i] = updater(msg);
            return updated;
          }
        }
        return prev;
      });
    },
    [],
  );

  /** Append text to the last text message, or create a new one */
  const appendText = useCallback((content: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.type === 'text') {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...last,
          content: last.content + content,
        };
        return updated;
      }
      return [...prev, { type: 'text' as const, content }];
    });
  }, []);

  /** Append thought content to the last thought message, or create a new one */
  const appendThought = useCallback((content: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.type === 'thought') {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...last,
          content: last.content + content,
        };
        return updated;
      }
      return [...prev, { type: 'thought' as const, content }];
    });
  }, []);

  const sendMessage = useCallback(
    async (text: string, apiKey: string, providerId: string) => {
      const trimmed = text.trim();
      if (!trimmed || (providerId !== 'local' && !apiKey)) return;

      // Abort any previous request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMsg: ChatMessage = { type: 'user', content: trimmed };
      const newMessages: ChatMessage[] = [...messages, userMsg];
      setMessages(newMessages);
      setStreaming(true);

      // Track in-flight tool calls by ID
      const pendingToolIds = new Set<string>();
      const { agent, progress } = getAgentHandle();

      // Subscribe to sub-agent progress
      progress.setListener((agentName, step) => {
        setMessages((prev) => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            const msg = updated[i];
            if (
              msg.type === 'tool_call' &&
              msg.name === agentName &&
              msg.status === 'active'
            ) {
              updated[i] = {
                ...msg,
                progressSteps: [...(msg.progressSteps || []), step],
              };
              return updated;
            }
          }
          return prev;
        });
      });

      try {
        const lcMessages = toLangChainMessages(newMessages);

        const stream = await agent.stream(
          { messages: lcMessages },
          {
            streamMode: 'messages',
            signal: controller.signal,
            recursionLimit: 100,
          },
        );

        for await (const tuple of stream) {
          if (controller.signal.aborted) break;

          const [chunk, metadata] = tuple as [
            AIMessageChunk,
            Record<string, unknown>,
          ];
          const node = metadata?.langgraph_node as string | undefined;

          // ── Tool results from the tools node ──
          if (node === 'tools') {
            const toolCallId = (chunk as unknown as { tool_call_id?: string })
              .tool_call_id;
            const resultContent =
              typeof chunk.content === 'string'
                ? chunk.content
                : JSON.stringify(chunk.content);

            if (toolCallId && pendingToolIds.has(toolCallId)) {
              const isError =
                resultContent.startsWith('API error') ||
                resultContent.startsWith('Fetch failed');
              updateToolCall(toolCallId, (tc) => ({
                ...tc,
                result: resultContent,
                status: isError ? 'error' : 'success',
                endTime: Date.now(),
              }));
            }
            continue;
          }

          // Only process remaining chunks from the agent (LLM) node
          if (node !== 'agent') continue;

          // ── Thinking content (Anthropic extended thinking) ──
          if (Array.isArray(chunk.content)) {
            const thinkingBlocks = chunk.content.filter(
              (b): b is { type: 'thinking'; thinking: string } =>
                typeof b === 'object' &&
                b !== null &&
                'type' in b &&
                b.type === 'thinking',
            );
            for (const block of thinkingBlocks) {
              if (block.thinking) {
                appendThought(block.thinking);
              }
            }
          }

          // ── Tool call chunks from the agent ──
          if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
            for (const tc of chunk.tool_call_chunks) {
              if (tc.name) {
                // New tool call starting
                const toolId = tc.id || `tc_${Date.now()}_${tc.name}`;
                pendingToolIds.add(toolId);
                appendMessage({
                  type: 'tool_call',
                  id: toolId,
                  name: tc.name,
                  args: tc.args || '',
                  status: 'active',
                  startTime: Date.now(),
                });
              } else if (tc.args) {
                // Streaming args for existing tool call — update last active
                updateLast<ToolCallMessage>('tool_call', (msg) =>
                  msg.status === 'active'
                    ? { ...msg, args: msg.args + tc.args }
                    : msg,
                );
              }
            }
            continue;
          }

          // ── Text content ──
          const content =
            typeof chunk.content === 'string'
              ? chunk.content
              : Array.isArray(chunk.content)
                ? chunk.content
                    .filter(
                      (b): b is { type: 'text'; text: string } =>
                        typeof b === 'object' &&
                        b !== null &&
                        'type' in b &&
                        b.type === 'text',
                    )
                    .map((b) => b.text)
                    .join('')
                : '';

          if (content) {
            appendText(content);
          }
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        appendText(`Error: ${msg}`);
      } finally {
        progress.setListener(null);
        setStreaming(false);
      }
    },
    [
      messages,
      getAgentHandle,
      appendMessage,
      appendText,
      appendThought,
      updateLast,
      updateToolCall,
    ],
  );

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStreaming(false);
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, streaming, sendMessage, clearChat, abort };
}
