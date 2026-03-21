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
import { PROVIDERS } from './providers';
import {
  loadApiKey,
  saveApiKey,
  loadProviderChoice,
  saveProviderChoice,
  loadModelChoice,
  saveModelChoice,
  loadLocalUrl,
  saveLocalUrl,
} from './storage';
import { useResizablePanel } from './useResizablePanel';
import { useChatAgent } from './useChatAgent';
import ChatSettings from './ChatSettings';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import ChatTemplates from './ChatTemplates';
import type { ChatPanelProps, ChatAgentHandle } from './types';
import './ChatPanel.css';
import './chat.css';

const DEFAULT_TEMPLATES = [
  {
    label: 'Overview',
    description: 'Architecture overview with node types and connections',
    prompt:
      "Give me an overview of this system's architecture. What node types exist and how are they connected?",
  },
  {
    label: 'List services',
    description: 'Enumerate services and describe their roles',
    prompt:
      'Search the code for services in this system. Look for classes, modules, or files that act as services and briefly describe what each one does based on its connections and source code.',
  },
  {
    label: 'Find dependencies',
    description: 'Identify critical nodes with the most connections',
    prompt:
      'What are the most critical dependencies in this system? Which nodes have the most incoming connections?',
  },
  {
    label: 'Database usage',
    description: 'Which databases exist and what connects to them',
    prompt:
      'Search the code for database usage in this system. Look for database connections, ORMs, query builders, or migration files and describe which components interact with databases.',
  },
];

export default function ChatPanel({
  onClose,
  createAgent,
  title = 'AI Assistant',
  templates,
  tools,
  tabs,
  onWidthChange,
  defaultWidth = 480,
  minWidth = 320,
  maxWidth = 800,
  storageKey = 'ot_chat_panel_width',
}: ChatPanelProps) {
  const { width: panelWidth, handleMouseDown } = useResizablePanel({
    storageKey,
    defaultWidth,
    minWidth,
    maxWidth,
    side: 'left',
  });

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
  const [showSettings, setShowSettings] = useState(false);
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');

  // Cache agent — recreate only when provider or key changes
  const agentRef = useRef<ChatAgentHandle | null>(null);
  const agentKeyRef = useRef('');

  const getAgentHandle = useCallback((): ChatAgentHandle => {
    const key = `${providerId}:${modelId}:${apiKey}:${localUrl}`;
    if (agentKeyRef.current !== key || !agentRef.current) {
      agentRef.current = createAgent(providerId, modelId, apiKey, localUrl);
      agentKeyRef.current = key;
    }
    return agentRef.current;
  }, [providerId, modelId, apiKey, localUrl, createAgent]);

  const { messages, streaming, sendMessage, clearChat } = useChatAgent({
    getAgentHandle,
  });

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

  const handleSettingsSave = (
    newKey: string,
    newLocalUrl?: string,
    newModel?: string,
  ) => {
    saveApiKey(providerId, newKey);
    setApiKey(newKey);

    if (providerId === 'local') {
      if (newLocalUrl) {
        saveLocalUrl(newLocalUrl);
        setLocalUrl(newLocalUrl);
      }
      if (newModel) {
        saveModelChoice('local', newModel);
        setModelId(newModel);
      }
      setShowSettings(false);
    } else if (newKey) {
      setShowSettings(false);
    }
  };

  const handleSubmit = () => {
    if (!input.trim() || streaming) return;
    const text = input;
    setInput('');
    sendMessage(text, apiKey, providerId);
  };

  const handleTemplate = (prompt: string) => {
    sendMessage(prompt, apiKey, providerId);
  };

  const handleClearChat = () => {
    clearChat();
  };

  const needsKey = providerId !== 'local' && !apiKey;
  const showSettingsView = showSettings || needsKey;
  const hasTabs = tabs && tabs.length > 0;
  const activeTemplates = templates ?? DEFAULT_TEMPLATES;

  // Find active extra tab
  const activeExtraTab = tabs?.find((t) => t.id === activeTab);

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
          <h3>{title}</h3>
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

      {hasTabs && !showSettingsView && (
        <div className="chat-tab-bar">
          <button
            className={`chat-tab ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            Chat
          </button>
          {tabs!.map((tab) => (
            <button
              key={tab.id}
              className={`chat-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {showSettingsView ? (
        <ChatSettings
          providerId={providerId}
          modelId={modelId}
          apiKey={apiKey}
          localUrl={localUrl}
          onProviderChange={switchProvider}
          onModelChange={switchModel}
          onSave={handleSettingsSave}
          onCancel={() => setShowSettings(false)}
          canCancel={!!(apiKey || providerId === 'local')}
        />
      ) : activeExtraTab ? (
        activeExtraTab.render()
      ) : (
        <>
          {messages.length === 0 ? (
            <div className="messages">
              <div className="empty-chat">
                <p>Ask me anything about your graph!</p>
                <ChatTemplates
                  templates={activeTemplates}
                  onSelect={handleTemplate}
                />
              </div>
            </div>
          ) : (
            <ChatMessages
              messages={messages}
              streaming={streaming}
              tools={tools}
            />
          )}
          <ChatInput
            input={input}
            streaming={streaming}
            onInputChange={setInput}
            onSubmit={handleSubmit}
            onSettingsClick={() => setShowSettings(true)}
          />
        </>
      )}
    </div>
  );
}
