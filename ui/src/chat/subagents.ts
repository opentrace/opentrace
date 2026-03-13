import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
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

const CODE_REVIEWER_PROMPT = `You are a code review agent. Your job is to review code changes for quality issues, bugs, security vulnerabilities, and adherence to codebase conventions by combining source code inspection with architecture context from the OpenTrace knowledge graph.

## Workflow

1. **Identify scope**: If given a PR reference, use list_pull_requests / get_pull_request to find the PR and its changed files. Otherwise, use search_graph to locate the component being reviewed.
2. **Load source**: Use load_source on each changed/relevant file to read the actual code.
3. **Understand context**: Use traverse_graph (incoming + outgoing) to understand how changed code fits into the broader architecture — what calls it, what it depends on.
4. **Inspect related code**: Use get_node and load_source on related components to check for consistency and convention adherence.
5. **Synthesize review**: Produce a structured code review.

## Review Categories

Evaluate code across these dimensions, but only report categories where you find issues:

- **Bugs & Logic Errors** — incorrect conditions, off-by-one, null/undefined risks, race conditions
- **Security** — injection, auth bypass, secrets exposure, unsafe deserialization
- **Performance** — N+1 queries, unnecessary allocations, missing pagination, blocking I/O
- **Error Handling** — swallowed errors, missing validation at boundaries, unclear error messages
- **Design & Architecture** — violations of existing patterns, tight coupling, missing abstractions
- **Naming & Clarity** — misleading names, unclear intent, overly complex logic

## Response Format

### Summary
One-paragraph overview of the changes and overall quality assessment.

### Issues Found
For each issue:
- **[Category] Severity: High/Medium/Low** — file:location
  Description of the issue and why it matters.
  Suggested fix (if applicable).

### Positive Observations
Note well-written code, good patterns, or improvements over existing code.

## Guidelines

- Focus on substantive issues, not style nitpicks
- Reference existing codebase patterns when suggesting changes ("the rest of the codebase does X")
- Distinguish between must-fix (bugs, security) and nice-to-have (style, minor performance)
- If you cannot find the relevant code, say so rather than guessing
- When reviewing PRs, use summarize_pr_changes to understand blast radius

## CRITICAL: Structured Output

After your prose review, you MUST end your response with a fenced code block tagged \`json:review\` containing structured review data that can be submitted to GitHub/GitLab. Use this exact format:

\`\`\`json:review
{
  "summary": "One-paragraph overall assessment of the changes",
  "verdict": "APPROVE or REQUEST_CHANGES or COMMENT",
  "comments": [
    {
      "path": "src/example.ts",
      "line": 42,
      "body": "Description of the issue or suggestion"
    }
  ]
}
\`\`\`

Rules for the structured block:
- "verdict": Use APPROVE if the code is good, REQUEST_CHANGES if there are must-fix issues, COMMENT for informational review
- "comments": Include one entry per actionable finding. Use the exact file path and line number from the source code. Omit path/line if the comment is general.
- "summary": A concise paragraph suitable as the PR review body on GitHub
- Always include this block, even if there are no issues (empty comments array, APPROVE verdict)`;

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
  prTools: StructuredToolInterface[] = [],
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

  const codeReviewerAgent = createReactAgent({
    llm,
    tools: [...graphTools, ...prTools],
    stateModifier: CODE_REVIEWER_PROMPT,
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

  const codeReviewer = tool(
    async ({ query }) => {
      try {
        const response = await streamSubAgent(
          codeReviewerAgent,
          'code_reviewer',
          query,
          onProgress,
        );
        return truncate(response, MAX_SUBAGENT_RESULT_CHARS);
      } catch (err) {
        return `Code review failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'code_reviewer',
      description:
        'Delegates a code review task to a specialized sub-agent. ' +
        'The sub-agent autonomously loads source code, checks dependencies, and inspects ' +
        'PR changes to produce a structured review with bugs, security issues, and quality feedback. ' +
        "Use this for questions like 'review PR #42' or 'review the authentication module for security issues'.",
      schema: z.object({
        query: z
          .string()
          .describe(
            'The code review request — what to review and any focus areas',
          ),
      }),
    },
  );

  return [codeExplorer, dependencyAnalyzer, codeReviewer];
}
