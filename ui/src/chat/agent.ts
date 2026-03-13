import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { makeGraphTools } from './tools';
import { makePRTools } from './prTools';
import { makeSubAgentTools, type ProgressFn } from './subagents';
import type { GraphStore } from '../store/types';
import type { PRClient } from '../pr/client';

export interface SubAgentProgressHandle {
  /** Set a listener to receive sub-agent progress steps. Pass null to unsubscribe. */
  setListener(fn: ProgressFn | null): void;
}

export function createLLM(
  providerId: string,
  modelId: string,
  apiKey: string,
  baseUrl?: string,
): BaseChatModel {
  switch (providerId) {
    case 'anthropic':
      return new ChatAnthropic({
        model: modelId,
        apiKey,
        clientOptions: { dangerouslyAllowBrowser: true },
      });
    case 'openai':
      return new ChatOpenAI({ model: modelId, apiKey });
    case 'gemini':
      return new ChatGoogleGenerativeAI({ model: modelId, apiKey });
    case 'local':
      return new ChatOpenAI({
        model: modelId,
        apiKey: apiKey || 'local',
        configuration: { baseURL: `${baseUrl}/v1` },
      });
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

export function createChatAgent(
  providerId: string,
  modelId: string,
  apiKey: string,
  systemPrompt: string,
  store: GraphStore,
  prClient?: PRClient | null,
  baseUrl?: string,
) {
  const llm = createLLM(providerId, modelId, apiKey, baseUrl);
  const graphTools = makeGraphTools(store);
  const prTools = makePRTools(store, prClient);

  // Mutable listener — set by ChatPanel, called by sub-agent tools
  let listener: ProgressFn | null = null;
  const emitProgress: ProgressFn = (agentName, step) =>
    listener?.(agentName, step);

  const subAgentTools = makeSubAgentTools(llm, store, emitProgress, prTools);
  const agent = createReactAgent({
    llm,
    tools: [...graphTools, ...prTools, ...subAgentTools],
    stateModifier: systemPrompt,
  });

  const progress: SubAgentProgressHandle = {
    setListener(fn) {
      listener = fn;
    },
  };

  return { agent, progress };
}
