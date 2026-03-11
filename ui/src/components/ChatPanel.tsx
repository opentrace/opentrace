import { useEffect, useRef, useState } from "react";
import type { GraphNode, GraphLink } from "../types/graph";
import {
  PROVIDERS,
  PROVIDER_IDS,
  type ChatMessage,
  type AssistantMessage,
  type MessagePart,
} from "../chat/providers";
import {
  loadApiKey,
  saveApiKey,
  loadProviderChoice,
  saveProviderChoice,
} from "../chat/storage";
import { buildGraphContext } from "../chat/graphContext";
import { createChatAgent } from "../chat/agent";
import ChatTemplates from "../chat/ChatTemplates";
import ChatParts from "../chat/ChatParts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { AIMessageChunk } from "@langchain/core/messages";
import { useStore } from "../store";
import "../chat/markdown.css";
import "../chat/parts.css";
import "./ChatPanel.css";

interface Props {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  onClose: () => void;
}

export default function ChatPanel({ graphData, onClose }: Props) {
  const { store } = useStore();

  const [providerId, setProviderId] = useState(loadProviderChoice);
  const [apiKey, setApiKey] = useState(() => loadApiKey(loadProviderChoice()));
  const [showSettings, setShowSettings] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  // Cache agent — recreate only when provider or key changes
  const agentRef = useRef<ReturnType<typeof createChatAgent> | null>(null);
  const agentKeyRef = useRef("");

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
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
  };

  const handleSaveKey = () => {
    const val = keyInputRef.current?.value.trim() ?? "";
    saveApiKey(providerId, val);
    setApiKey(val);
    if (val) setShowSettings(false);
  };

  const getAgent = () => {
    const key = `${providerId}:${apiKey}`;
    if (agentKeyRef.current !== key || !agentRef.current) {
      const systemPrompt = buildGraphContext(
        graphData.nodes as GraphNode[],
        graphData.links as GraphLink[],
      );
      agentRef.current = createChatAgent(providerId, apiKey, systemPrompt, store);
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
        .filter((p) => p.type === "text")
        .map((p) => p.content)
        .join("");
      updated[updated.length - 1] = { ...last, parts: newParts, content };
      return updated;
    });
  };

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !apiKey || streaming) return;

    // Abort any previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg: ChatMessage = { role: "user", content: trimmed };
    const assistantMsg: AssistantMessage = { role: "assistant", content: "", parts: [] };
    const newMessages: ChatMessage[] = [...messages, userMsg];
    setMessages([...newMessages, assistantMsg]);
    setInput("");
    setStreaming(true);

    // Track in-flight tool calls by ID to match results later
    const pendingTools = new Map<string, number>(); // tool_call_id → parts index

    try {
      const agent = getAgent();

      // Convert to LangChain message format (text-only for history)
      const lcMessages = newMessages.map((m) =>
        m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content),
      );

      const stream = await agent.stream(
        { messages: lcMessages },
        { streamMode: "messages", signal: controller.signal },
      );

      for await (const tuple of stream) {
        if (controller.signal.aborted) break;

        const [chunk, metadata] = tuple as [AIMessageChunk, Record<string, unknown>];
        const node = metadata?.langgraph_node as string | undefined;

        // ── Tool results from the tools node ──
        if (node === "tools") {
          const toolCallId = (chunk as unknown as { tool_call_id?: string }).tool_call_id;
          const resultContent =
            typeof chunk.content === "string"
              ? chunk.content
              : JSON.stringify(chunk.content);

          if (toolCallId && pendingTools.has(toolCallId)) {
            const partIdx = pendingTools.get(toolCallId)!;
            const isError = resultContent.startsWith("API error") || resultContent.startsWith("Fetch failed");
            updateLastParts((parts) => {
              const tc = parts[partIdx];
              if (tc.type === "tool_call") {
                parts[partIdx] = {
                  ...tc,
                  result: resultContent,
                  status: isError ? "error" : "success",
                  endTime: Date.now(),
                };
              }
              return parts;
            });
          }
          continue;
        }

        // Only process remaining chunks from the agent (LLM) node
        if (node !== "agent") continue;

        // ── Thinking content (Anthropic extended thinking) ──
        if (Array.isArray(chunk.content)) {
          const thinkingBlocks = chunk.content.filter(
            (b): b is { type: "thinking"; thinking: string } =>
              typeof b === "object" && b !== null && "type" in b && b.type === "thinking",
          );
          for (const block of thinkingBlocks) {
            if (block.thinking) {
              updateLastParts((parts) => {
                const last = parts[parts.length - 1];
                if (last?.type === "thought") {
                  parts[parts.length - 1] = { ...last, content: last.content + block.thinking };
                } else {
                  parts.push({ type: "thought", content: block.thinking });
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
                  type: "tool_call",
                  id: toolId,
                  name: tc.name!,
                  args: tc.args || "",
                  status: "active",
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
                  if (p.type === "tool_call" && p.status === "active") {
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
          typeof chunk.content === "string"
            ? chunk.content
            : Array.isArray(chunk.content)
              ? chunk.content
                  .filter(
                    (b): b is { type: "text"; text: string } =>
                      typeof b === "object" && b !== null && "type" in b && b.type === "text",
                  )
                  .map((b) => b.text)
                  .join("")
              : "";

        if (content) {
          updateLastParts((parts) => {
            const last = parts[parts.length - 1];
            if (last?.type === "text") {
              parts[parts.length - 1] = { ...last, content: last.content + content };
            } else {
              parts.push({ type: "text", content });
            }
            return parts;
          });
        }
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      updateLastParts((parts) => {
        parts.push({ type: "text", content: `Error: ${msg}` });
        return parts;
      });
    } finally {
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

  const needsKey = !apiKey;
  const showSettingsView = showSettings || needsKey;

  return (
    <div className="chat-panel">
      <div className="panel-header">
        <h3>AI Assistant</h3>
        <div className="panel-header-actions">
          {messages.length > 0 && (
            <button className="clear-chat-btn" onClick={handleClearChat} title="New chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.855z" />
              </svg>
            </button>
          )}
          <button className="close-btn" onClick={onClose}>
            &times;
          </button>
        </div>
      </div>

      {showSettingsView ? (
        <div className="api-key-config">
          <div className="provider-selector">
            {PROVIDER_IDS.map((id) => (
              <button
                key={id}
                className={id === providerId ? "active" : ""}
                onClick={() => switchProvider(id)}
              >
                {PROVIDERS[id].name}
              </button>
            ))}
          </div>
          <p>Enter your {PROVIDERS[providerId].name} API key:</p>
          <input
            key={providerId}
            ref={keyInputRef}
            type="password"
            placeholder="API Key..."
            defaultValue={apiKey}
            onKeyDown={(e) => e.key === "Enter" && handleSaveKey()}
            className="api-key-input"
          />
          <button
            className="api-search-btn"
            style={{ width: "100%", padding: "8px", marginTop: "8px" }}
            onClick={handleSaveKey}
          >
            Save
          </button>
          <p className="hint">Your key is stored locally in your browser.</p>
        </div>
      ) : (
        <>
          <div className="messages" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="empty-chat">
                <p>Ask me anything about your graph!</p>
                <ChatTemplates onSelect={handleTemplate} />
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`message ${m.role === "user" ? "user" : "ai"}`}>
                <div className="message-content">
                  {m.role === "assistant" ? (
                    <ChatParts
                      parts={(m as AssistantMessage).parts}
                      streaming={streaming && i === messages.length - 1}
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
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            <button onClick={handleSubmit} disabled={streaming || !input.trim()}>
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
