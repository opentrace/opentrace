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

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { makeGraphTools } from './tools';
import type { GraphStore } from '../store/types';

const MAX_SUBAGENT_RESULT_CHARS = 12000;

/** Callback for reporting sub-agent progress to the UI */
export type ProgressFn = (agentName: string, step: string) => void;

// ---- Step label mapping ----

const STEP_LABELS: Record<string, string> = {
  search_graph: 'Searching graph',
  list_nodes: 'Listing nodes',
  get_node: 'Inspecting node',
  traverse_graph: 'Traversing connections',
  load_source: 'Loading source',
  find_usages: 'Finding usages',
  find_dependencies: 'Finding dependencies',
  explore_component: 'Exploring component',
  explore: 'Exploring graph',
  analyze_blast_radius: 'Analyzing blast radius',
  code_reviewer: 'Reviewing code',
};

function stepLabel(toolName: string): string {
  return STEP_LABELS[toolName] ?? toolName;
}

// ---- System prompts ----
//
// Sub-agents return raw structured JSON so the main (parent) agent can
// synthesize a user-facing response.  Each prompt ends with an output-format
// contract the sub-agent must follow.

const FIND_USAGES_PROMPT = `You are a usage-finding agent with access to the OpenTrace knowledge graph.
Given a target component (by name or ID), find everything that calls, imports, or depends on it.

## Workflow
1. Use search_graph to locate the target node. If multiple matches, pick the best one.
2. Use traverse_graph with direction: incoming, depth: 3 to find all consumers.
3. Optionally use get_node on key consumers for extra detail.

## CRITICAL: Output Format
Return ONLY a fenced JSON code block — no prose, no markdown headings.
The parent agent will synthesize a user-facing answer from your raw data.

\`\`\`json
{
  "summary": "Short one-sentence description of what was found",
  "target": { "id": "...", "name": "...", "type": "..." },
  "usages": [
    { "id": "...", "name": "...", "type": "...", "relationship": "CALLS", "depth": 1 }
  ],
  "totalCount": 12
}
\`\`\`

Include up to 50 usages. Set totalCount to the real total even if you truncate the list.
The "summary" must be a single plain-text sentence (no markdown) describing what was found, e.g. "Found 12 callers of AuthService, mostly in the API layer."`;

const DEPENDENCY_ANALYZER_PROMPT = `You are a dependency analysis agent. Your job is to help developers understand the impact of changes by mapping dependencies through the OpenTrace knowledge graph.

## Workflow
1. Use search_graph to locate the target node.
2. Use traverse_graph with direction: outgoing, depth: 3 to map dependencies.
3. Optionally use get_node on important dependencies for extra detail.

## CRITICAL: Output Format
Return ONLY a fenced JSON code block — no prose, no markdown headings.

\`\`\`json
{
  "summary": "Short one-sentence description of what was found",
  "target": { "id": "...", "name": "...", "type": "..." },
  "dependencies": [
    { "id": "...", "name": "...", "type": "...", "relationship": "CALLS", "depth": 1 }
  ],
  "totalCount": 8
}
\`\`\`

Include up to 50 dependencies. Set totalCount to the real total even if you truncate the list.
The "summary" must be a single plain-text sentence (no markdown), e.g. "UserService depends on 8 components including DatabaseClient and AuthProvider."`;

const EXPLORE_COMPONENT_PROMPT = `You are a component exploration agent with access to the OpenTrace knowledge graph.
Given a query about a codebase component, perform a thorough multi-step exploration.

## Workflow
1. Use search_graph to find relevant nodes.
2. Use get_node on the best match for full properties.
3. Use traverse_graph with direction: both to map the neighborhood (incoming and outgoing).
4. Use load_source if the query asks about implementation details.

## CRITICAL: Output Format
Return ONLY a fenced JSON code block — no prose, no markdown headings.

\`\`\`json
{
  "summary": "Short one-sentence description of what was found",
  "node": { "id": "...", "name": "...", "type": "...", "properties": {} },
  "incoming": [
    { "id": "...", "name": "...", "type": "...", "relationship": "..." }
  ],
  "outgoing": [
    { "id": "...", "name": "...", "type": "...", "relationship": "..." }
  ],
  "source": [
    { "path": "...", "startLine": 1, "endLine": 50, "snippet": "..." }
  ],
  "related": [
    { "id": "...", "name": "...", "type": "..." }
  ]
}
\`\`\`

Include up to 30 neighbors per direction and up to 3 source snippets.
Omit the "source" key if no source was loaded.
The "summary" must be a single plain-text sentence (no markdown), e.g. "AuthService is a Class with 5 incoming callers and 3 outgoing dependencies."`;

const BLAST_RADIUS_PROMPT = `You are a blast-radius analysis agent with access to the OpenTrace knowledge graph.
Given a target component, map both what depends on it AND what it depends on to assess the impact of changes.

## Workflow
1. Use search_graph to locate the target node.
2. Use traverse_graph with direction: incoming, depth: 3 for consumers.
3. Use traverse_graph with direction: outgoing, depth: 3 for dependencies.
4. Optionally use get_node on high-fanout nodes for detail.

## CRITICAL: Output Format
Return ONLY a fenced JSON code block — no prose, no markdown headings.

\`\`\`json
{
  "summary": "Short one-sentence description of the impact",
  "target": { "id": "...", "name": "...", "type": "..." },
  "upstream": {
    "direct": [{ "id": "...", "name": "...", "type": "...", "relationship": "..." }],
    "transitive": [{ "id": "...", "name": "...", "type": "...", "depth": 2 }]
  },
  "downstream": {
    "direct": [{ "id": "...", "name": "...", "type": "...", "relationship": "..." }],
    "transitive": [{ "id": "...", "name": "...", "type": "...", "depth": 2 }]
  },
  "counts": {
    "directConsumers": 5,
    "transitiveConsumers": 12,
    "directDependencies": 3,
    "transitiveDependencies": 7
  }
}
\`\`\`

Include up to 30 nodes per section. Set counts to real totals.
The "summary" must be a single plain-text sentence (no markdown), e.g. "Changing DatabaseClient would affect 17 consumers across 3 services."`;

const EXPLORE_GRAPH_PROMPT = `You are a graph exploration agent with access to the OpenTrace knowledge graph.
Given an open-ended question about the codebase, autonomously explore the graph to find the answer.

## Workflow
1. Use search_graph to find nodes related to the question. Try multiple search terms if the first doesn't match.
2. Use get_node on promising results to inspect their properties.
3. Use traverse_graph (both directions) to discover how nodes are connected — follow interesting paths.
4. Use load_source when the question involves implementation details, code patterns, or specific logic.
5. Use explore_node for a single-call deep dive on a specific component.
6. Iterate: if your first exploration doesn't fully answer the question, refine your search and explore further.

## Guidelines
- Be thorough — follow multiple paths through the graph if the question is broad.
- Prioritize breadth first (search, list) then depth (traverse, load_source) on interesting results.
- If you find something unexpected or relevant, investigate it even if it wasn't directly asked about.
- Adapt your strategy based on what you find — the graph structure should guide your exploration.

## CRITICAL: Output Format
Return ONLY a fenced JSON code block — no prose, no markdown headings.
The parent agent will synthesize a user-facing answer from your raw data.

\`\`\`json
{
  "summary": "Short one-sentence answer to the question",
  "findings": [
    {
      "label": "Brief heading for this finding",
      "nodes": [{ "id": "...", "name": "...", "type": "..." }],
      "detail": "Explanation of what was discovered"
    }
  ],
  "connections": [
    { "from": "...", "to": "...", "type": "CALLS", "detail": "..." }
  ],
  "source_snippets": [
    { "path": "...", "startLine": 1, "endLine": 20, "snippet": "..." }
  ]
}
\`\`\`

Include up to 10 findings, 30 connections, and 5 source snippets.
Omit "source_snippets" if none were loaded.
The "summary" must be a single plain-text sentence (no markdown) directly answering the question.`;

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

  // ── Focused sub-agents ──────────────────────────────────────────────────

  const findUsagesAgent = createReactAgent({
    llm,
    tools: graphTools,
    stateModifier: FIND_USAGES_PROMPT,
  });

  const findDependenciesAgent = createReactAgent({
    llm,
    tools: graphTools,
    stateModifier: DEPENDENCY_ANALYZER_PROMPT,
  });

  const exploreComponentAgent = createReactAgent({
    llm,
    tools: graphTools,
    stateModifier: EXPLORE_COMPONENT_PROMPT,
  });

  const blastRadiusAgent = createReactAgent({
    llm,
    tools: graphTools,
    stateModifier: BLAST_RADIUS_PROMPT,
  });

  const codeReviewerAgent = createReactAgent({
    llm,
    tools: [...graphTools, ...prTools],
    stateModifier: CODE_REVIEWER_PROMPT,
  });

  const exploreGraphAgent = createReactAgent({
    llm,
    tools: graphTools,
    stateModifier: EXPLORE_GRAPH_PROMPT,
  });

  // ── Tool wrappers exposed to the main agent ─────────────────────────────

  const findUsages = tool(
    async ({ query }) => {
      try {
        const response = await streamSubAgent(
          findUsagesAgent,
          'find_usages',
          query,
          onProgress,
        );
        return truncate(response, MAX_SUBAGENT_RESULT_CHARS);
      } catch (err) {
        return `Find usages failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'find_usages',
      description:
        'Find all callers, consumers, and importers of a component. ' +
        'Returns structured JSON listing every node that depends on the target. ' +
        "Use for questions like 'what calls X?', 'what uses X?', 'who imports X?'.",
      schema: z.object({
        query: z
          .string()
          .describe('The component to find usages of (name or ID)'),
      }),
    },
  );

  const findDependencies = tool(
    async ({ query }) => {
      try {
        const response = await streamSubAgent(
          findDependenciesAgent,
          'find_dependencies',
          query,
          onProgress,
        );
        return truncate(response, MAX_SUBAGENT_RESULT_CHARS);
      } catch (err) {
        return `Find dependencies failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'find_dependencies',
      description:
        'Find everything a component depends on, calls, or imports. ' +
        'Returns structured JSON of outgoing dependencies. ' +
        "Use for questions like 'what does X depend on?', 'what does X call?', 'what does X import?'.",
      schema: z.object({
        query: z
          .string()
          .describe('The component to find dependencies of (name or ID)'),
      }),
    },
  );

  const exploreComponent = tool(
    async ({ query }) => {
      try {
        const response = await streamSubAgent(
          exploreComponentAgent,
          'explore_component',
          query,
          onProgress,
        );
        return truncate(response, MAX_SUBAGENT_RESULT_CHARS);
      } catch (err) {
        return `Component exploration failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'explore_component',
      description:
        'Deep multi-step exploration of a component: finds it, inspects properties, ' +
        'maps neighbors in both directions, and optionally loads source code. ' +
        'Returns structured JSON with the full picture. ' +
        "Use for questions like 'explain X', 'how does X work?', 'walk me through X'.",
      schema: z.object({
        query: z.string().describe('The exploration question to investigate'),
      }),
    },
  );

  const analyzeBlastRadius = tool(
    async ({ query }) => {
      try {
        const response = await streamSubAgent(
          blastRadiusAgent,
          'analyze_blast_radius',
          query,
          onProgress,
        );
        return truncate(response, MAX_SUBAGENT_RESULT_CHARS);
      } catch (err) {
        return `Blast radius analysis failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'analyze_blast_radius',
      description:
        'Analyze the full impact of changing a component by mapping both upstream ' +
        'consumers and downstream dependencies. Returns structured JSON with counts ' +
        'and node lists. ' +
        "Use for questions like 'what is the blast radius of X?', 'what would break if I change X?'.",
      schema: z.object({
        query: z
          .string()
          .describe('The component to analyze impact for (name or ID)'),
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

  const explore = tool(
    async ({ query }) => {
      try {
        const response = await streamSubAgent(
          exploreGraphAgent,
          'explore',
          query,
          onProgress,
        );
        return truncate(response, MAX_SUBAGENT_RESULT_CHARS);
      } catch (err) {
        return `Graph exploration failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'explore',
      description:
        'Autonomous graph exploration agent — delegates an open-ended question to a ' +
        'sub-agent that searches, traverses, and inspects nodes to find the answer. ' +
        'The sub-agent decides its own exploration strategy based on the question. ' +
        'Returns structured JSON with findings, connections, and optional source snippets. ' +
        "Use for broad questions like 'how is authentication implemented?', " +
        "'what services talk to the database?', 'explain the data flow for X'.",
      schema: z.object({
        query: z.string().describe('The question to explore in the graph'),
      }),
    },
  );

  return [
    findUsages,
    findDependencies,
    exploreComponent,
    analyzeBlastRadius,
    codeReviewer,
    explore,
  ];
}
