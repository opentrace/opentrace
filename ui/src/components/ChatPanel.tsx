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

import { useCallback, useMemo } from 'react';
import type { GraphNode, GraphLink } from '@opentrace/components/utils';
import {
  ChatPanel as GenericChatPanel,
  type ChatAgentHandle,
  type ChatTab,
} from '@opentrace/components/chat';
import { useStore } from '../store';
import { PRClient, parseRepoUrl } from '../pr/client';
import { buildGraphContext } from '../chat/graphContext';
import { createChatAgent, createLLM } from '../chat/agent';
import { OPENTRACE_TEMPLATES } from '../chat/templates';
import { buildToolConfig } from '../chat/toolConfig';
import PRListPanel from './PRListPanel';

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

  const prClient = useMemo(() => {
    if (!repoUrl) return null;
    const meta = parseRepoUrl(repoUrl);
    if (!meta) return null;
    const tokenKey =
      meta.provider === 'gitlab' ? 'ot_gitlab_pat' : 'ot_github_pat';
    const token = localStorage.getItem(tokenKey) ?? undefined;
    return new PRClient(meta, token);
  }, [repoUrl]);

  const createAgent = useCallback(
    (
      providerId: string,
      modelId: string,
      apiKey: string,
      baseUrl?: string,
    ): ChatAgentHandle => {
      const systemPrompt = buildGraphContext(
        graphData.nodes as GraphNode[],
        graphData.links as GraphLink[],
      );
      return createChatAgent(
        providerId,
        modelId,
        apiKey,
        systemPrompt,
        store,
        prClient,
        baseUrl,
      );
    },
    [graphData.nodes, graphData.links, store, prClient],
  );

  const handlePostComment = useCallback(
    async (number: number, body: string) => {
      if (!prClient) throw new Error('No PR client configured');
      await prClient.postComment(number, body);
    },
    [prClient],
  );

  const tools = useMemo(
    () =>
      buildToolConfig(onNodeSelect, prClient ? handlePostComment : undefined),
    [onNodeSelect, prClient, handlePostComment],
  );

  // LLM instance for PR reviews (run directly, not through chat)
  const llm = useMemo(() => {
    const providerId = localStorage.getItem('ot_chat_provider') ?? 'gemini';
    const modelId = localStorage.getItem('ot_chat_model_' + providerId) ?? '';
    const apiKey = localStorage.getItem('ot_chat_apikey_' + providerId) ?? '';
    const localUrl = localStorage.getItem('ot_chat_local_url') ?? '';
    if (providerId !== 'local' && !apiKey) return null;
    try {
      return createLLM(
        providerId,
        modelId || 'gemini-2.5-flash',
        apiKey,
        localUrl,
      );
    } catch {
      return null;
    }
  }, []);

  const tabs: ChatTab[] | undefined = useMemo(() => {
    if (!prClient) return undefined;
    return [
      {
        id: 'prs',
        label: 'Pull Requests',
        render: () => (
          <PRListPanel
            prClient={prClient}
            store={store}
            onGraphChange={onGraphChange}
            llm={llm}
          />
        ),
      },
    ];
  }, [prClient, store, onGraphChange, llm]);

  return (
    <GenericChatPanel
      onClose={onClose}
      createAgent={createAgent}
      title="AI Assistant"
      templates={OPENTRACE_TEMPLATES}
      tools={tools}
      tabs={tabs}
      onNodeSelect={onNodeSelect}
      onWidthChange={onWidthChange}
    />
  );
}
