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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode, GraphLink } from '@opentrace/components/utils';
import {
  PROVIDERS,
  PROVIDER_IDS,
  API_KEY_RESOURCES,
  type ChatMessage,
  type AssistantMessage,
  type MessagePart,
} from '../chat/providers';
import {
  loadApiKey,
  saveApiKey,
  loadProviderChoice,
  saveProviderChoice,
  loadModelChoice,
  saveModelChoice,
  loadLocalUrl,
  saveLocalUrl,
} from '../chat/storage';
import { buildGraphContext } from '../chat/graphContext';
import { createChatAgent, createLLM } from '../chat/agent';
import { ChatTemplates, ChatParts } from '@opentrace/components/chat';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { AIMessageChunk } from '@langchain/core/messages';
import { useStore } from '../store';
import { PRClient, parseRepoUrl } from '../pr/client';
import { useResizablePanel } from '../hooks/useResizablePanel';
import PRListPanel from './PRListPanel';
import './ChatPanel.css';

type TabId = 'chat' | 'prs';

interface Props {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  onClose: () => void;
  onNodeSelect?: (nodeId: string) => void;
  onGraphChange?: (focusNodeId?: string) => Promise<void>;
  repoUrl?: string;
  onWidthChange?: (width: number) => void;
}

export default function ChatPanel({
  graphData,
  onClose,
  onNodeSelect,
  onGraphChange,
  repoUrl,
  onWidthChange,
}: Props) {
  const { store } = useStore();

  const { width: panelWidth, handleMouseDown } = useResizablePanel({
    storageKey: 'ot_chat_panel_width',
    defaultWidth: 480,
    minWidth: 320,
    maxWidth: 800,
    side: 'left',
  });

  // Notify parent of width changes so graph canvas can adjust
  useEffect(() => {
    onWidthChange?.(panelWidth);
  }, [panelWidth, onWidthChange]);

  const [providerId, setProviderId] = useState(loadProviderChoice);
  const [modelId, setModelId] = useState(() => {
    const pid = loadProviderChoice();
    return loadModelChoice(pid) ?? PROVIDERS[pid].defaultModel;
  });
  const [apiKey, setApiKey] = useState(() => loadApiKey(loadProviderChoice()));
  const [localUrl, setLocalUrl] = useState(loadLocalUrl);
  const [localModels, setLocalModels] = useState<string[] | null>(null);
  const [localModelsFetching, setLocalModelsFetching] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const localUrlInputRef = useRef<HTMLInputElement>(null);
  const localModelInputRef = useRef<HTMLInputElement>(null);

  // Build PRClient from repoUrl
  const prClient = useMemo(() => {
    if (!repoUrl) return null;
    const meta = parseRepoUrl(repoUrl);
    if (!meta) return null;
    // Use the same localStorage keys as AddRepoModal
    const tokenKey =
      meta.provider === 'gitlab' ? 'ot_gitlab_pat' : 'ot_github_pat';
    const token = localStorage.getItem(tokenKey) ?? undefined;
    return new PRClient(meta, token);
  }, [repoUrl]);

  // Cache agent — recreate only when provider or key changes
  const agentRef = useRef<ReturnType<typeof createChatAgent> | null>(null);
  const agentKeyRef = useRef('');
  type AgentHandle = ReturnType<typeof createChatAgent>;

  // Auto-scroll only when the user is near the bottom
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

  // Cancel in-flight request on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const switchProvider = (id: string) => {
    setProviderId(id);
    saveProviderChoice(id);
    setApiKey(loadApiKey(id));
    const savedModel = loadModelChoice(id);
    setModelId(savedModel ?? PROVIDERS[id].defaultModel);
    if (id === 'local') setLocalUrl(loadLocalUrl());
    setShowSettings(true);
  };

  const switchModel = (model: string) => {
    setModelId(model);
    saveModelChoice(providerId, model);
  };

  const handleSaveKey = () => {
    const val = keyInputRef.current?.value.trim() ?? '';
    saveApiKey(providerId, val);
    setApiKey(val);

    if (providerId === 'local') {
      const url = localUrlInputRef.current?.value.trim() ?? '';
      if (url) {
        saveLocalUrl(url);
        setLocalUrl(url);
      }
      // modelId state already holds the correct value whether from dropdown or text input
      const model =
        localModels && localModels.length > 0
          ? modelId
          : (localModelInputRef.current?.value.trim() ?? modelId);
      if (model) {
        saveModelChoice('local', model);
        setModelId(model);
      }
      setShowSettings(false);
    } else if (val) {
      setShowSettings(false);
    }
  };

  const fetchLocalModels = async () => {
    const url = localUrlInputRef.current?.value.trim() || localUrl;
    setLocalModelsFetching(true);
    setLocalModels(null);
    try {
      const res = await fetch(`${url}/v1/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const ids: string[] = (json.data ?? []).map((m: { id: string }) => m.id);
      setLocalModels(ids);
      if (ids.length > 0 && !ids.includes(modelId)) {
        setModelId(ids[0]);
      }
    } catch {
      setLocalModels([]);
    } finally {
      setLocalModelsFetching(false);
    }
  };

  const getAgentHandle = (): AgentHandle => {
    const key = `${providerId}:${modelId}:${apiKey}:${localUrl}:${repoUrl ?? ''}`;
    if (agentKeyRef.current !== key || !agentRef.current) {
      const systemPrompt = buildGraphContext(
        graphData.nodes as GraphNode[],
        graphData.links as GraphLink[],
      );
      agentRef.current = createChatAgent(
        providerId,
        modelId,
        apiKey,
        systemPrompt,
        store,
        prClient,
        localUrl,
      );
      agentKeyRef.current = key;
    }
    return agentRef.current;
  };

  /** Update the parts array in the last (assistant) message */
  const updateLastParts = (fn: (parts: MessagePart[]) => MessagePart[]) => {
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
  };

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || (providerId !== 'local' && !apiKey) || streaming) return;

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
    setInput('');
    setStreaming(true);

    // Track in-flight tool calls by ID to match results later
    const pendingTools = new Map<string, number>(); // tool_call_id → parts index
    const { agent, progress } = getAgentHandle();

    // Subscribe to sub-agent progress — pushes steps into active agent ToolCallParts
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
      // Convert to LangChain message format (text-only for history)
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
                // Find the last active tool_call part and append args
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
  };

  const handleSubmit = () => sendMessage(input);
  const handleTemplate = (prompt: string) => sendMessage(prompt);
  const handleClearChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    setStreaming(false);
  };

  /** Switch to chat tab and send a pre-seeded prompt (used by PR panel) */
  const handleChatWithPR = (prompt: string) => {
    setActiveTab('chat');
    abortRef.current?.abort();
    sendMessage(prompt);
  };

  /** Post a comment on a PR (used by SuggestCommentResult widget) */
  const handlePostComment = async (number: number, body: string) => {
    if (!prClient) throw new Error('No PR client configured');
    await prClient.postComment(number, body);
  };

  // LLM instance for PR reviews (run directly, not through chat)
  const llm = useMemo(() => {
    if (providerId !== 'local' && !apiKey) return null;
    try {
      return createLLM(providerId, modelId, apiKey, localUrl);
    } catch {
      return null;
    }
  }, [providerId, modelId, apiKey, localUrl]);

  const needsKey = providerId !== 'local' && !apiKey;
  const showSettingsView = showSettings || needsKey;
  const hasPRTab = !!prClient;

  return (
    <div className="chat-panel" style={{ width: panelWidth }}>
      <div className="chat-panel-drag-handle" onMouseDown={handleMouseDown} />
      <div className="panel-header">
        <div className="panel-header-title">
          <svg
            className="ai-icon"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
            <path d="M20 3v4" />
            <path d="M22 5h-4" />
            <path d="M4 17v2" />
            <path d="M5 18H3" />
          </svg>
          <h3>AI Assistant</h3>
          {!showSettingsView && (apiKey || providerId === 'local') && (
            <span
              className="provider-tag"
              onClick={() => setShowSettings(true)}
              title="Click to change provider or model"
            >
              {PROVIDERS[providerId].models.find((m) => m.id === modelId)
                ?.name ?? modelId}
            </span>
          )}
        </div>
        <div className="panel-header-actions">
          {messages.length > 0 && (
            <button
              className="clear-chat-btn"
              onClick={handleClearChat}
              title="New chat"
              data-testid="new-chat-btn"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 20h9" />
                <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.855z" />
              </svg>
            </button>
          )}
          <button className="close-btn" onClick={onClose}>
            &times;
          </button>
        </div>
      </div>

      {hasPRTab && !showSettingsView && (
        <div className="chat-tab-bar">
          <button
            className={`chat-tab ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            Chat
          </button>
          <button
            className={`chat-tab ${activeTab === 'prs' ? 'active' : ''}`}
            onClick={() => setActiveTab('prs')}
          >
            Pull Requests
          </button>
        </div>
      )}

      {showSettingsView ? (
        <div className="api-key-config">
          <div className="provider-selector">
            {PROVIDER_IDS.map((id) => (
              <button
                key={id}
                className={id === providerId ? 'active' : ''}
                onClick={() => switchProvider(id)}
              >
                {PROVIDERS[id].name}
              </button>
            ))}
          </div>
          {providerId === 'local' ? (
            <>
              <div className="model-selector">
                <label htmlFor="local-url-input">URL</label>
                <input
                  id="local-url-input"
                  ref={localUrlInputRef}
                  type="text"
                  placeholder="http://localhost:11434"
                  defaultValue={localUrl}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
                  className="api-key-input"
                />
              </div>
              <div className="model-selector">
                <label htmlFor="local-model-input">Model</label>
                <div
                  style={{ display: 'flex', gap: '6px', alignItems: 'stretch' }}
                >
                  {localModels && localModels.length > 0 ? (
                    <select
                      id="local-model-input"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      className="api-key-input"
                      style={{ flex: 1, marginBottom: 0 }}
                    >
                      {localModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="local-model-input"
                      ref={localModelInputRef}
                      type="text"
                      placeholder="llama3.2"
                      defaultValue={modelId}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
                      className="api-key-input"
                      style={{ flex: 1, marginBottom: 0 }}
                    />
                  )}
                  <button
                    className="settings-back-btn"
                    onClick={fetchLocalModels}
                    disabled={localModelsFetching}
                    title="Fetch available models from the server"
                    style={{ alignSelf: 'stretch' }}
                  >
                    {localModelsFetching ? '…' : 'Fetch'}
                  </button>
                </div>
                {localModels !== null && localModels.length === 0 && (
                  <p
                    className="hint"
                    style={{ color: 'var(--color-error, #f87171)' }}
                  >
                    Could not reach server or no models found.
                  </p>
                )}
              </div>
              <p>API key (optional):</p>
              <input
                key={providerId}
                ref={keyInputRef}
                type="password"
                placeholder="Leave blank if not required"
                defaultValue={apiKey}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
                className="api-key-input"
              />
            </>
          ) : (
            <>
              <div className="model-selector">
                <label htmlFor="model-select">Model</label>
                <select
                  id="model-select"
                  value={modelId}
                  onChange={(e) => switchModel(e.target.value)}
                >
                  {PROVIDERS[providerId].models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <p>Enter your {PROVIDERS[providerId].name} API key:</p>
              <input
                key={providerId}
                ref={keyInputRef}
                type="password"
                placeholder="API Key..."
                defaultValue={apiKey}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
                className="api-key-input"
              />
              {API_KEY_RESOURCES[providerId] && (
                <div className="api-key-help">
                  <p className="api-key-help-title">
                    How to get your {PROVIDERS[providerId].name} key:
                  </p>
                  <ol className="api-key-steps">
                    <li>
                      Sign up at{' '}
                      <a
                        href={API_KEY_RESOURCES[providerId].signup}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {API_KEY_RESOURCES[providerId].signupLabel}
                      </a>
                    </li>
                    {API_KEY_RESOURCES[providerId].steps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                  <p className="api-key-help-footer">
                    See the{' '}
                    <a
                      href="https://opentrace.github.io/opentrace/reference/chat-providers/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      OpenTrace docs
                    </a>{' '}
                    or{' '}
                    <a
                      href={API_KEY_RESOURCES[providerId].docs}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {PROVIDERS[providerId].name} docs
                    </a>{' '}
                    for more details.
                  </p>
                </div>
              )}
            </>
          )}
          <div className="settings-actions">
            <button
              className="settings-save-btn"
              style={{ flex: 1, padding: '8px' }}
              onClick={handleSaveKey}
            >
              Save
            </button>
            {(apiKey || providerId === 'local') && (
              <button
                className="settings-back-btn"
                style={{ padding: '8px' }}
                onClick={() => setShowSettings(false)}
              >
                Cancel
              </button>
            )}
          </div>
          <p className="hint">Your key is stored locally in your browser.</p>
        </div>
      ) : activeTab === 'prs' && prClient ? (
        <PRListPanel
          prClient={prClient}
          store={store}
          onGraphChange={onGraphChange}
          llm={llm}
          onChatWithPR={handleChatWithPR}
        />
      ) : (
        <>
          <div className="messages" ref={scrollRef} onScroll={handleScroll}>
            {messages.length === 0 && (
              <div className="empty-chat">
                <p>Ask me anything about your graph!</p>
                <ChatTemplates onSelect={handleTemplate} />
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`message ${m.role === 'user' ? 'user' : 'ai'}`}
                {...(m.role === 'assistant' &&
                i === messages.length - 1 &&
                !streaming
                  ? { 'data-testid': 'chat-response-done' }
                  : {})}
              >
                <div className="message-content">
                  {m.role === 'assistant' ? (
                    <ChatParts
                      parts={(m as AssistantMessage).parts}
                      streaming={streaming && i === messages.length - 1}
                      onNodeSelect={onNodeSelect}
                      onPostComment={prClient ? handlePostComment : undefined}
                    />
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="chat-input-area">
            <input
              type="text"
              placeholder="Ask a question..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            />
            <button
              onClick={handleSubmit}
              disabled={streaming || !input.trim()}
              data-testid="chat-send-btn"
            >
              Send
            </button>
            <button
              className="settings-btn"
              onClick={() => setShowSettings(true)}
              title="Provider Settings"
            >
              &#9881;
            </button>
          </div>
        </>
      )}
    </div>
  );
}
