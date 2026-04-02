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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode, GraphLink } from '@opentrace/components/utils';
import {
  PROVIDERS,
  PROVIDER_IDS,
  API_KEY_RESOURCES,
  type ChatMessage,
  type AssistantMessage,
  type MessagePart,
} from '../chat/providers';
import type { Attachment, ImageAttachment } from '../components/chat/types';
import {
  processFiles,
  clipboardToFiles,
  dropToFiles,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../chat/attachmentUtils';
import {
  loadApiKey,
  saveApiKey,
  loadProviderChoice,
  saveProviderChoice,
  loadModelChoice,
  saveModelChoice,
  loadLocalUrl,
  saveLocalUrl,
  loadChatHistoryEnabled,
  saveChatHistoryEnabled,
} from '../chat/storage';
import { buildGraphContext } from '../chat/graphContext';
import { createChatAgent, createLLM } from '../chat/agent';
import {
  ChatTemplates,
  ChatParts,
  extractNodeIds,
} from '@opentrace/components/chat';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { AIMessageChunk } from '@langchain/core/messages';
import { useStore } from '../store';
import { PRClient, parseRepoUrl } from '../pr/client';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { useConversation } from '../chat/useConversation';
import PRListPanel from './PRListPanel';
import './ChatPanel.css';

type TabId = 'chat' | 'prs';

interface Props {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  onClose: () => void;
  onNodeSelect?: (nodeId: string) => void;
  onGraphChange?: (focusNodeId?: string) => Promise<void>;
  /** Called with accumulated highlight set and the new IDs to ping */
  onChatHighlight?: (allNodeIds: Set<string>, newNodeIds: string[]) => void;
  repoUrl?: string;
  onWidthChange?: (width: number) => void;
  /** Optional content rendered at the bottom of the settings view (e.g. managed provider UI). */
  settingsFooter?: React.ReactNode;
}

export default function ChatPanel({
  graphData,
  onClose,
  onNodeSelect,
  onGraphChange,
  onChatHighlight,
  repoUrl,
  onWidthChange,
  settingsFooter,
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
  const [historyEnabled, setHistoryEnabled] = useState(loadChatHistoryEnabled);
  const {
    conversationId,
    conversations,
    messages,
    setMessages,
    startNewConversation,
    switchConversation,
    deleteConversation,
    persistMessages,
    loadingConversation,
    foundNodeIds: restoredFoundNodeIds,
  } = useConversation(repoUrl, historyEnabled);

  const [showSettings, setShowSettings] = useState(false);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [highlightEnabled, setHighlightEnabled] = useState(true);
  const [hasFoundNodes, setHasFoundNodes] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Accumulated node IDs found by chat tool results */
  const chatFoundNodesRef = useRef<Set<string>>(new Set());
  const keyInputRef = useRef<HTMLInputElement>(null);
  const localUrlInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>(
    [],
  );
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const [lightboxImage, setLightboxImage] = useState<ImageAttachment | null>(
    null,
  );
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

  // Keep messagesRef in sync with state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Close attach menu on outside click
  useEffect(() => {
    if (!showAttachMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        attachMenuRef.current &&
        !attachMenuRef.current.contains(e.target as Node)
      ) {
        setShowAttachMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showAttachMenu]);

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

  // Restore chat graph highlights when switching conversations
  useEffect(() => {
    chatFoundNodesRef.current = new Set(restoredFoundNodeIds);
    const hasNodes = restoredFoundNodeIds.length > 0;
    setHasFoundNodes(hasNodes);
    if (highlightEnabled && hasNodes) {
      onChatHighlight?.(new Set(restoredFoundNodeIds), []);
    } else {
      onChatHighlight?.(new Set(), []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire when restored node IDs change
  }, [restoredFoundNodeIds]);

  // Sync highlight state when toggle changes
  useEffect(() => {
    if (highlightEnabled && chatFoundNodesRef.current.size > 0) {
      onChatHighlight?.(new Set(chatFoundNodesRef.current), []);
    } else if (!highlightEnabled) {
      onChatHighlight?.(new Set(), []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on toggle change
  }, [highlightEnabled]);

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

  const sendMessage = async (
    text: string,
    images?: ImageAttachment[],
    attachments?: Attachment[],
  ) => {
    const trimmed = text.trim();
    const hasImages = images && images.length > 0;
    const hasAtts = attachments && attachments.length > 0;
    if (
      (!trimmed && !hasImages && !hasAtts) ||
      (providerId !== 'local' && !apiKey) ||
      streaming
    )
      return;

    // Abort any previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg: ChatMessage = {
      role: 'user',
      content: trimmed,
      ...(hasImages ? { images } : {}),
      ...(hasAtts ? { attachments } : {}),
    };
    const assistantMsg: AssistantMessage = {
      role: 'assistant',
      content: '',
      parts: [],
    };
    const newMessages: ChatMessage[] = [...messages, userMsg];
    setMessages([...newMessages, assistantMsg]);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setStreaming(true);

    // Track in-flight tool calls by ID to match results later
    const pendingTools = new Map<
      string,
      { idx: number; name: string; args: string }
    >(); // tool_call_id → {parts index, tool name, accumulated args}
    let lastToolId = ''; // tracks the most recently started tool call for arg accumulation
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
      // Convert to LangChain message format
      const lcMessages = newMessages.map((m) => {
        if (m.role === 'user') {
          const imgs = m.images;
          const atts = m.attachments;
          const hasImgs = imgs && imgs.length > 0;
          const hasFileAtts = atts && atts.length > 0;

          if (hasImgs || hasFileAtts) {
            const contentParts: Array<
              | { type: 'text'; text: string }
              | { type: 'image_url'; image_url: { url: string } }
            > = [];

            // Add file attachment contents as text blocks
            if (hasFileAtts) {
              for (const att of atts) {
                if (att.kind === 'file') {
                  const lines = att.textContent.split('\n').length;
                  const bytes = new Blob([att.textContent]).size;
                  contentParts.push({
                    type: 'text' as const,
                    text:
                      `<attached_file name="${att.name}" lines="${lines}" bytes="${bytes}">\n` +
                      `${att.textContent}\n` +
                      `</attached_file>`,
                  });
                } else if (att.kind === 'image') {
                  contentParts.push({
                    type: 'image_url' as const,
                    image_url: { url: att.dataUrl },
                  });
                }
              }
            }

            // Legacy image attachments
            if (hasImgs) {
              for (const img of imgs) {
                contentParts.push({
                  type: 'image_url' as const,
                  image_url: { url: img.dataUrl },
                });
              }
            }

            // User text
            if (m.content) {
              contentParts.push({
                type: 'text' as const,
                text: m.content,
              });
            }

            return new HumanMessage({ content: contentParts });
          }
          return new HumanMessage(m.content);
        }
        return new AIMessage(m.content);
      });

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
            const {
              idx: partIdx,
              name: toolName,
              args: toolArgs,
            } = pendingTools.get(toolCallId)!;
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
            // Highlight found nodes in the graph
            if (!isError) {
              const ids = extractNodeIds(toolName, resultContent, toolArgs);
              console.log('[ChatPanel] extractNodeIds', {
                toolName,
                idCount: ids.length,
                ids: ids.slice(0, 5),
                toolArgs: toolArgs.slice(0, 200),
              });
              if (ids.length > 0) {
                for (const id of ids) chatFoundNodesRef.current.add(id);
                setHasFoundNodes(true);
                onChatHighlight?.(
                  highlightEnabled
                    ? new Set(chatFoundNodesRef.current)
                    : new Set(),
                  highlightEnabled ? ids : [],
                );
              }
            }
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
                lastToolId = toolId;
                pendingTools.set(toolId, {
                  idx,
                  name: tc.name!,
                  args: tc.args || '',
                });
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
              // Also accumulate in pendingTools so args are available at result time
              if (lastToolId && pendingTools.has(lastToolId)) {
                pendingTools.get(lastToolId)!.args += tc.args;
              }
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
      setStreaming(false);
      progress.setListener(null);
      // Persist conversation after each completed turn (skip if user aborted)
      if (!controller.signal.aborted) {
        persistMessages(
          messagesRef.current,
          providerId,
          modelId,
          Array.from(chatFoundNodesRef.current),
        );
      }
    }
  };

  const handleSubmit = () => {
    const atts = pendingAttachments.length > 0 ? pendingAttachments : undefined;
    const trimmed = input.trim();
    const hasAtts = atts && atts.length > 0;
    // Only clear attachments if sendMessage will actually proceed
    if (
      (trimmed || hasAtts) &&
      (providerId === 'local' || apiKey) &&
      !streaming
    ) {
      setPendingAttachments([]);
    }
    sendMessage(input, undefined, atts);
  };
  const handleTemplate = (prompt: string) => sendMessage(prompt);

  const addAttachments = useCallback(
    async (files: File[]) => {
      setAttachError(null);
      const remaining = MAX_ATTACHMENTS_PER_MESSAGE - pendingAttachments.length;
      if (remaining <= 0) {
        setAttachError(
          `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`,
        );
        return;
      }
      const { attachments, errors } = await processFiles(
        files.slice(0, remaining),
      );
      if (errors.length) setAttachError(errors.join(' '));
      if (attachments.length)
        setPendingAttachments((prev) => [...prev, ...attachments]);
    },
    [pendingAttachments.length],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = clipboardToFiles(e.nativeEvent as ClipboardEvent);
      if (files.length > 0) {
        e.preventDefault();
        addAttachments(files);
      }
    },
    [addAttachments],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = dropToFiles(e.nativeEvent as DragEvent);
      if (files.length > 0) addAttachments(files);
    },
    [addAttachments],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the panel itself, not when entering a child
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);
  const handleClearChat = () => {
    abortRef.current?.abort();
    startNewConversation();
    setStreaming(false);
    chatFoundNodesRef.current.clear();
    setHasFoundNodes(false);
    setHighlightEnabled(true);
    setShowHistory(false);
    onChatHighlight?.(new Set(), []);
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
    <div
      className="chat-panel"
      style={{ width: panelWidth }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="chat-panel-drag-handle" onMouseDown={handleMouseDown} />
      {dragOver && (
        <div className="image-drop-overlay">
          <div className="image-drop-overlay-content">
            <span className="image-drop-icon">&#128206;</span>
            <span>Drop files here</span>
          </div>
        </div>
      )}
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
          {!showSettingsView &&
            !showHistory &&
            (apiKey || providerId === 'local') && (
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
          {hasFoundNodes && (
            <button
              className={`clear-chat-btn${highlightEnabled ? ' active' : ''}`}
              onClick={() => setHighlightEnabled((v) => !v)}
              title={
                highlightEnabled
                  ? 'Hide graph highlights'
                  : 'Show graph highlights'
              }
              style={{ opacity: highlightEnabled ? 1 : 0.5 }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill={highlightEnabled ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2" />
                <path d="M12 20v2" />
                <path d="M4.93 4.93l1.41 1.41" />
                <path d="M17.66 17.66l1.41 1.41" />
                <path d="M2 12h2" />
                <path d="M20 12h2" />
                <path d="M6.34 17.66l-1.41 1.41" />
                <path d="M19.07 4.93l-1.41 1.41" />
              </svg>
            </button>
          )}
          {(conversations.length > 0 || showHistory) && (
            <button
              className={`clear-chat-btn${showHistory ? ' active' : ''}`}
              onClick={() => setShowHistory((v) => !v)}
              title="Chat history"
              data-testid="chat-history-btn"
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
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </button>
          )}
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
          <button className="close-btn" onClick={onClose}>
            &times;
          </button>
        </div>
      </div>

      {hasPRTab && !showSettingsView && !showHistory && (
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

      {showHistory ? (
        <div className="chat-history-panel">
          <div className="chat-history-header">
            <span>Conversations</span>
          </div>
          <div className="chat-history-list">
            {conversations.map((c) => (
              <div
                key={c.id}
                className={`chat-history-item ${c.id === conversationId ? 'active' : ''}`}
                onClick={() => {
                  switchConversation(c.id);
                  setShowHistory(false);
                }}
              >
                <div className="chat-history-item-title">{c.title}</div>
                <div className="chat-history-item-meta">
                  {new Date(c.updatedAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                  {' \u00B7 '}
                  {c.model}
                </div>
                <button
                  className="chat-history-item-delete"
                  title="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConversation(c.id);
                  }}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : showSettingsView ? (
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
          {settingsFooter}
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
            {loadingConversation && (
              <div className="empty-chat">
                <p>Loading conversation...</p>
              </div>
            )}
            {!loadingConversation && messages.length === 0 && (
              <div className="empty-chat">
                <p>Ask me anything about your graph!</p>
                <div
                  className="chat-save-card"
                  onClick={() => {
                    const next = !historyEnabled;
                    setHistoryEnabled(next);
                    saveChatHistoryEnabled(next);
                  }}
                >
                  <div className="chat-save-card-info">
                    <strong>Save this conversation</strong>
                    <p>
                      Store this chat locally in your browser so you can resume
                      it later.
                    </p>
                  </div>
                  <div
                    className={`chat-toggle-track${historyEnabled ? ' on' : ''}`}
                  >
                    <div className="chat-toggle-thumb" />
                  </div>
                </div>
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
                    <>
                      {m.content}
                      {m.attachments && m.attachments.length > 0 && (
                        <div className="user-message-attachments">
                          {m.attachments.map((att) =>
                            att.kind === 'image' ? (
                              <img
                                key={att.id}
                                src={att.dataUrl}
                                alt={att.name || 'Attached image'}
                                className="user-message-image"
                                onClick={() => setLightboxImage(att)}
                              />
                            ) : (
                              <div
                                key={att.id}
                                className="user-message-file"
                                title={att.name}
                              >
                                <span className="file-icon">&#128196;</span>
                                <span className="file-name">{att.name}</span>
                              </div>
                            ),
                          )}
                        </div>
                      )}
                      {m.images && m.images.length > 0 && (
                        <div className="user-message-images">
                          {m.images.map((img) => (
                            <img
                              key={img.id}
                              src={img.dataUrl}
                              alt={img.name || 'Attached image'}
                              className="user-message-image"
                              onClick={() => setLightboxImage(img)}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="chat-input-area">
            {attachError && (
              <div className="image-error-banner">
                {attachError}
                <button onClick={() => setAttachError(null)}>&times;</button>
              </div>
            )}
            {pendingAttachments.length > 0 && (
              <div className="image-preview-strip">
                {pendingAttachments.map((att) => (
                  <div
                    key={att.id}
                    className={
                      att.kind === 'image'
                        ? 'image-preview-thumb'
                        : 'file-preview-thumb'
                    }
                  >
                    {att.kind === 'image' ? (
                      <img src={att.dataUrl} alt={att.name || 'Attachment'} />
                    ) : (
                      <div className="file-preview-content">
                        <span className="file-icon">&#128196;</span>
                        <span className="file-preview-name">{att.name}</span>
                      </div>
                    )}
                    <button
                      className="image-remove-btn"
                      onClick={() => removeAttachment(att.id)}
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Ask a question..."
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              onPaste={handlePaste}
            />
            <div className="chat-input-row">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files)
                    addAttachments(Array.from(e.target.files));
                  e.target.value = '';
                }}
              />
              <div className="attach-menu-wrapper" ref={attachMenuRef}>
                <button
                  className="attach-btn chat-action-btn"
                  onClick={() => setShowAttachMenu((v) => !v)}
                  title="Attach"
                >
                  +
                </button>
                {showAttachMenu && (
                  <div className="attach-menu">
                    <button
                      className="attach-menu-item"
                      onClick={() => {
                        fileInputRef.current?.click();
                        setShowAttachMenu(false);
                      }}
                    >
                      <span className="attach-menu-icon">&#128206;</span>
                      File / Image
                    </button>
                  </div>
                )}
              </div>
              <button
                className="settings-btn chat-action-btn"
                onClick={() => setShowSettings(true)}
                title="Provider Settings"
              >
                &#9881;
              </button>
              <div style={{ flex: 1 }} />
              <button
                className="chat-action-btn"
                onClick={handleSubmit}
                disabled={
                  streaming ||
                  (!input.trim() && pendingAttachments.length === 0)
                }
                data-testid="chat-send-btn"
                title="Send"
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
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}
      {lightboxImage && (
        <div
          className="image-lightbox-overlay"
          onClick={() => setLightboxImage(null)}
        >
          <button
            className="image-lightbox-close"
            onClick={() => setLightboxImage(null)}
          >
            &times;
          </button>
          <img
            src={lightboxImage.dataUrl}
            alt={lightboxImage.name || 'Full size image'}
            className="image-lightbox-img"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
