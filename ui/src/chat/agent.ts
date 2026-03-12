import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { makeGraphTools } from './tools';
import { makeSubAgentTools, type ProgressFn } from './subagents';
import type { GraphStore } from '../store/types';

export interface SubAgentProgressHandle {
  /** Set a listener to receive sub-agent progress steps. Pass null to unsubscribe. */
  setListener(fn: ProgressFn | null): void;
}

function createLLM(providerId: string, apiKey: string): BaseChatModel {
  switch (providerId) {
    case 'anthropic':
      return new ChatAnthropic({
        model: 'claude-sonnet-4-5-20250929',
        apiKey,
        clientOptions: { dangerouslyAllowBrowser: true },
      });
    case 'openai':
      return new ChatOpenAI({ model: 'gpt-4o-mini', apiKey });
    case 'gemini':
      return new ChatGoogleGenerativeAI({ model: 'gemini-2.0-flash', apiKey });
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

export function createChatAgent(
  providerId: string,
  apiKey: string,
  systemPrompt: string,
  store: GraphStore,
) {
  const llm = createLLM(providerId, apiKey);
  const graphTools = makeGraphTools(store);

  // Mutable listener — set by ChatPanel, called by sub-agent tools
  let listener: ProgressFn | null = null;
  const emitProgress: ProgressFn = (agentName, step) =>
    listener?.(agentName, step);

  const subAgentTools = makeSubAgentTools(llm, store, emitProgress);
  const agent = createReactAgent({
    llm,
    tools: [...graphTools, ...subAgentTools],
    stateModifier: systemPrompt,
  });

  const progress: SubAgentProgressHandle = {
    setListener(fn) {
      listener = fn;
    },
  };

  return { agent, progress };
}
