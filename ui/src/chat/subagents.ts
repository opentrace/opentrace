import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { makeGraphTools } from './tools';
import type { GraphStore } from '../store/types';

const MAX_SUBAGENT_RESULT_CHARS = 8000;

/** Callback for reporting sub-agent progress to the UI */
export type ProgressFn = (agentName: string, step: string) => void;

// ---- Step label mapping ----

const STEP_LABELS: Record<string, string> = {
  search_graph: 'Searching graph',
  list_nodes: 'Listing nodes',
  get_node: 'Inspecting node',
  traverse_graph: 'Traversing connections',
  load_source: 'Loading source',
};

function stepLabel(toolName: string): string {
  return STEP_LABELS[toolName] ?? toolName;
}

// ---- System prompts ----

const CODE_EXPLORER_PROMPT = `You are a code exploration agent with access to the OpenTrace knowledge graph. Your job is to help developers understand their codebase by navigating the indexed graph of services, repositories, classes, functions, files, and their relationships.

## Workflow

1. **Find**: Use search_graph to locate nodes matching the query. Start broad.
2. **Inspect**: Use get_node to get full details on specific nodes and their neighbors.
3. **Trace**: Use traverse_graph to walk dependency trees:
   - direction: outgoing — what does this component depend on?
   - direction: incoming — what depends on this component?
   - direction: both — full neighborhood
4. **List**: Use list_nodes with a node type to enumerate all nodes of a given type.
5. **Read source**: Use load_source with a File or symbol node ID to fetch actual source code.

## Response Format

Present findings as structured summaries:
- Node type and name with ID for reference
- Properties (language, team, etc.)
- Relationships grouped by type (CALLS, READS, DEFINED_IN, etc.)

When presenting graph traversals, show the path clearly:
  ServiceA --CALLS--> ServiceB --READS--> DatabaseC

## Tips

- Start broad with search_graph, then drill down with get_node
- Use nodeTypes filter in search_graph to narrow results (e.g. "Service,Database")
- For "what calls this?" questions, traverse incoming edges
- For "what does this depend on?" questions, traverse outgoing edges
- When exploring unfamiliar code, start from Service or Repo nodes and traverse outward
- Use load_source to show actual code when the user asks about implementation details

Produce a clear, synthesized answer. Do NOT return raw JSON — summarize your findings in prose with structured lists.`;

const DEPENDENCY_ANALYZER_PROMPT = `You are a dependency analysis agent. Your job is to help developers understand the impact of changes by mapping dependencies through the OpenTrace knowledge graph.

## Workflow

1. **Locate target**: Use search_graph to find the component the user is asking about.
2. **Map consumers** (incoming): Use traverse_graph with direction: incoming to find everything that depends on this component.
3. **Map dependencies** (outgoing): Use traverse_graph with direction: outgoing to find everything this component depends on.
4. **Assess blast radius**: Combine incoming and outgoing traversals to build the full dependency picture.

## Response Format

Present analysis in three sections:

### Upstream (what depends on this)
List all consumers with depth annotations:
  [depth 1] ServiceA --CALLS--> TargetComponent
  [depth 2] APIGateway --CALLS--> ServiceA --CALLS--> TargetComponent

### Downstream (what this depends on)
List all dependencies:
  [depth 1] TargetComponent --READS--> DatabaseA
  [depth 1] TargetComponent --CALLS--> ServiceB

### Blast Radius Summary
- Direct consumers: Count and list of depth-1 incoming nodes
- Transitive consumers: Count of depth 2+ incoming nodes
- Direct dependencies: Count and list of depth-1 outgoing nodes
- Risk assessment: High/Medium/Low based on consumer count and node types

## Guidelines

- Use depth 3 for initial analysis, increase if deeper exploration is needed
- Filter by relationship type when asked about specific kinds of dependencies
- Highlight database dependencies as high-impact
- Flag services with many incoming connections as critical infrastructure

Produce a clear, synthesized answer. Do NOT return raw JSON — summarize your findings in prose with structured lists.`;

// ---- Helpers ----

/**
 * Walk messages in reverse to find the last AI text response.
 * Handles both string content and Anthropic array content format.
 */
function extractFinalResponse(
  messages: Array<{ content: string | Array<{ type: string; text?: string }> }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (typeof content === 'string' && content.trim()) {
      return content;
    }
    if (Array.isArray(content)) {
      const textParts = content
        .filter((part) => part.type === 'text' && part.text)
        .map((part) => part.text!)
        .join('\n');
      if (textParts.trim()) return textParts;
    }
  }
  return 'No response generated.';
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n...[truncated, ${text.length} chars total]`;
}

/**
 * Stream a sub-agent, emitting progress for each internal tool call.
 * Returns the final synthesized text response.
 */
async function streamSubAgent(
  agent: ReturnType<typeof createReactAgent>,
  agentName: string,
  query: string,
  onProgress: ProgressFn,
): Promise<string> {
  const allMessages: BaseMessage[] = [];

  const stream = await agent.stream(
    { messages: [new HumanMessage(query)] },
    { recursionLimit: 80 },
  );

  for await (const chunk of stream) {
    // Default stream mode yields per-node updates: { nodeName: { messages: [...] } }
    for (const [nodeName, update] of Object.entries(chunk)) {
      const msgs = (update as { messages?: BaseMessage[] })?.messages;
      if (!Array.isArray(msgs)) continue;

      for (const msg of msgs) {
        allMessages.push(msg);

        // When the agent node decides to call tools, report each as a progress step
        if (nodeName === 'agent') {
          const toolCalls = (msg as { tool_calls?: Array<{ name: string }> })
            .tool_calls;
          if (toolCalls?.length) {
            for (const tc of toolCalls) {
              onProgress(agentName, stepLabel(tc.name));
            }
          }
        }
      }
    }
  }

  return extractFinalResponse(
    allMessages as Array<{
      content: string | Array<{ type: string; text?: string }>;
    }>,
  );
}

// ---- Factory ----

export function makeSubAgentTools(
  llm: BaseChatModel,
  store: GraphStore,
  onProgress: ProgressFn,
) {
  const graphTools = makeGraphTools(store);

  const codeExplorerAgent = createReactAgent({
    llm,
    tools: graphTools,
    stateModifier: CODE_EXPLORER_PROMPT,
  });

  const dependencyAnalyzerAgent = createReactAgent({
    llm,
    tools: graphTools,
    stateModifier: DEPENDENCY_ANALYZER_PROMPT,
  });

  const codeExplorer = tool(
    async ({ query }) => {
      try {
        const response = await streamSubAgent(
          codeExplorerAgent,
          'code_explorer',
          query,
          onProgress,
        );
        return truncate(response, MAX_SUBAGENT_RESULT_CHARS);
      } catch (err) {
        return `Code exploration failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'code_explorer',
      description:
        'Delegates a complex code exploration task to a specialized sub-agent. ' +
        'The sub-agent autonomously searches the graph, inspects nodes, and traverses ' +
        'relationships to produce a synthesized answer. Use this for questions that require ' +
        "multiple lookups like 'explain the structure of ServiceX' or 'how is authentication implemented?'.",
      schema: z.object({
        query: z.string().describe('The exploration question to investigate'),
      }),
    },
  );

  const dependencyAnalyzer = tool(
    async ({ query }) => {
      try {
        const response = await streamSubAgent(
          dependencyAnalyzerAgent,
          'dependency_analyzer',
          query,
          onProgress,
        );
        return truncate(response, MAX_SUBAGENT_RESULT_CHARS);
      } catch (err) {
        return `Dependency analysis failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'dependency_analyzer',
      description:
        'Delegates a dependency or impact analysis task to a specialized sub-agent. ' +
        'The sub-agent autonomously maps upstream consumers, downstream dependencies, and ' +
        "blast radius. Use this for questions like 'what depends on ServiceX?' or " +
        "'what is the impact of changing DatabaseY?'.",
      schema: z.object({
        query: z
          .string()
          .describe('The dependency/impact analysis question to investigate'),
      }),
    },
  );

  return [codeExplorer, dependencyAnalyzer];
}
