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
import type {
  ChatMessage,
  AssistantMessage,
  MessagePart,
  ChatAgentHandle,
} from './types';

interface UseChatAgentOptions {
  getAgentHandle: () => ChatAgentHandle;
}

export function useChatAgent({ getAgentHandle }: UseChatAgentOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel in-flight request on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  /** Update the parts array in the last (assistant) message */
  const updateLastParts = useCallback(
    (fn: (parts: MessagePart[]) => MessagePart[]) => {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1] as AssistantMessage;
        const newParts = fn([...last.parts]);
        // Recompute content from text parts for LangChain history
        const content = newParts
          .filter((p) => p.type === 'text')
          .map((p) => p.content)
          .join('');
        updated[updated.length - 1] = { ...last, parts: newParts, content };
        return updated;
      });
    },
    [],
  );

  const sendMessage = useCallback(
    async (text: string, apiKey: string, providerId: string) => {
      const trimmed = text.trim();
      if (!trimmed || (providerId !== 'local' && !apiKey)) return;

      // Abort any previous request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMsg: ChatMessage = { role: 'user', content: trimmed };
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: '',
        parts: [],
      };
      const newMessages: ChatMessage[] = [...messages, userMsg];
      setMessages([...newMessages, assistantMsg]);
      setStreaming(true);

      // Track in-flight tool calls by ID to match results later
      const pendingTools = new Map<string, number>();
      const { agent, progress } = getAgentHandle();

      // Subscribe to sub-agent progress
      progress.setListener((agentName, step) => {
        updateLastParts((parts) => {
          for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (
              p.type === 'tool_call' &&
              p.name === agentName &&
              p.status === 'active'
            ) {
              parts[i] = {
                ...p,
                progressSteps: [...(p.progressSteps || []), step],
              };
              break;
            }
          }
          return parts;
        });
      });

      try {
        const lcMessages = newMessages.map((m) =>
          m.role === 'user'
            ? new HumanMessage(m.content)
            : new AIMessage(m.content),
        );

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

            if (toolCallId && pendingTools.has(toolCallId)) {
              const partIdx = pendingTools.get(toolCallId)!;
              const isError =
                resultContent.startsWith('API error') ||
                resultContent.startsWith('Fetch failed');
              updateLastParts((parts) => {
                const tc = parts[partIdx];
                if (tc.type === 'tool_call') {
                  parts[partIdx] = {
                    ...tc,
                    result: resultContent,
                    status: isError ? 'error' : 'success',
                    endTime: Date.now(),
                  };
                }
                return parts;
              });
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
                updateLastParts((parts) => {
                  const last = parts[parts.length - 1];
                  if (last?.type === 'thought') {
                    parts[parts.length - 1] = {
                      ...last,
                      content: last.content + block.thinking,
                    };
                  } else {
                    parts.push({ type: 'thought', content: block.thinking });
                  }
                  return parts;
                });
              }
            }
          }

          // ── Tool call chunks from the agent ──
          if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
            for (const tc of chunk.tool_call_chunks) {
              if (tc.name) {
                // New tool call starting
                const toolId = tc.id || `tc_${Date.now()}_${tc.name}`;
                updateLastParts((parts) => {
                  const idx = parts.length;
                  pendingTools.set(toolId, idx);
                  parts.push({
                    type: 'tool_call',
                    id: toolId,
                    name: tc.name!,
                    args: tc.args || '',
                    status: 'active',
                    startTime: Date.now(),
                  });
                  return parts;
                });
              } else if (tc.args) {
                // Streaming args for existing tool call
                updateLastParts((parts) => {
                  for (let i = parts.length - 1; i >= 0; i--) {
                    const p = parts[i];
                    if (p.type === 'tool_call' && p.status === 'active') {
                      parts[i] = { ...p, args: p.args + tc.args };
                      break;
                    }
                  }
                  return parts;
                });
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
            updateLastParts((parts) => {
              const last = parts[parts.length - 1];
              if (last?.type === 'text') {
                parts[parts.length - 1] = {
                  ...last,
                  content: last.content + content,
                };
              } else {
                parts.push({ type: 'text', content });
              }
              return parts;
            });
          }
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        updateLastParts((parts) => {
          parts.push({ type: 'text', content: `Error: ${msg}` });
          return parts;
        });
      } finally {
        progress.setListener(null);
        setStreaming(false);
      }
    },
    [messages, getAgentHandle, updateLastParts],
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
