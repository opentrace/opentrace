/**
 * Standalone PR review runner — invokes the code_reviewer sub-agent directly,
 * bypassing the chat agent to avoid duplicated output.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { makeGraphTools } from '../chat/tools';
import { makePRTools } from '../chat/prTools';
import type { GraphStore } from '../store/types';
import type { PRClient } from './client';
import type { PRDetail } from './types';

const STEP_LABELS: Record<string, string> = {
  search_graph: 'Searching graph',
  list_nodes: 'Listing nodes',
  get_node: 'Inspecting node',
  traverse_graph: 'Traversing connections',
  load_source: 'Loading source',
  list_pull_requests: 'Listing PRs',
  get_pull_request: 'Fetching PR details',
  summarize_pr_changes: 'Analyzing blast radius',
};

const CODE_REVIEWER_PROMPT = `You are a code review agent. Your job is to review code changes for quality issues, bugs, security vulnerabilities, and adherence to codebase conventions by combining source code inspection with architecture context from the OpenTrace knowledge graph.

## Workflow

1. **Identify scope**: Use get_pull_request to find the PR and its changed files with their diffs (in CHANGES edge properties).
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

function extractFinalResponse(
  messages: Array<{ content: string | Array<{ type: string; text?: string }> }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (typeof content === 'string' && content.trim()) return content;
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

export interface ReviewRunnerCallbacks {
  onProgress: (step: string) => void;
  signal?: AbortSignal;
}

/**
 * Runs a PR code review directly using a dedicated sub-agent.
 * Returns the raw review text (including the json:review block).
 */
export async function runPRReview(
  llm: BaseChatModel,
  store: GraphStore,
  prClient: PRClient | null,
  pr: PRDetail,
  meta: { owner: string; repo: string },
  callbacks: ReviewRunnerCallbacks,
): Promise<string> {
  const graphTools = makeGraphTools(store);
  const prTools = makePRTools(store, prClient);

  const agent = createReactAgent({
    llm,
    tools: [...graphTools, ...prTools],
    stateModifier: CODE_REVIEWER_PROMPT,
  });

  const prId = `${meta.owner}/${meta.repo}/pr/${pr.number}`;
  const query =
    `Review PR #${pr.number}: ${pr.title} (ID: ${prId}).\n` +
    `Changed files: ${pr.files.length}, +${pr.additions}/-${pr.deletions}.\n` +
    `Analyze all changed files for bugs, security issues, performance problems, and code quality.`;

  const allMessages: BaseMessage[] = [];

  const stream = await agent.stream(
    { messages: [new HumanMessage(query)] },
    { recursionLimit: 80, signal: callbacks.signal },
  );

  for await (const chunk of stream) {
    if (callbacks.signal?.aborted) break;

    for (const [nodeName, update] of Object.entries(chunk)) {
      const msgs = (update as { messages?: BaseMessage[] })?.messages;
      if (!Array.isArray(msgs)) continue;

      for (const msg of msgs) {
        allMessages.push(msg);

        if (nodeName === 'agent') {
          const toolCalls = (msg as { tool_calls?: Array<{ name: string }> })
            .tool_calls;
          if (toolCalls?.length) {
            for (const tc of toolCalls) {
              callbacks.onProgress(STEP_LABELS[tc.name] ?? tc.name);
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
