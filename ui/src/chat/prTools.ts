/**
 * LangChain tools for PR/MR operations in the chat agent.
 */

import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { GraphStore } from '../store/types';
import type { PRClient } from '../pr/client';

const MAX_RESULT_CHARS = 6000;
const MAX_SOURCE_CHARS = 8000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n...[truncated, ${text.length} chars total]`;
}

export function makePRTools(store: GraphStore, prClient?: PRClient | null) {
  const tools: StructuredToolInterface[] = [
    // Always available: query PR nodes from graph
    tool(
      async ({ limit }) => {
        const results = await store.listNodes('PullRequest', limit);
        return truncate(
          JSON.stringify({ pull_requests: results, count: results.length }),
          MAX_RESULT_CHARS,
        );
      },
      {
        name: 'list_pull_requests',
        description:
          'List PullRequest nodes that have been indexed into the graph. ' +
          'Returns PR metadata including number, title, state, author, and branches.',
        schema: z.object({
          limit: z.number().optional().describe('Max results (default 50)'),
        }),
      },
    ),
    tool(
      async ({ prId }) => {
        const node = await store.getNode(prId);
        if (!node)
          return JSON.stringify({ error: 'PR not found in graph', id: prId });

        // Traverse 2 hops: PR --CHANGES--> File --*--> neighbors
        const modifies = await store.traverse(prId, 'outgoing', 2, 'CHANGES');
        return truncate(
          JSON.stringify({
            pr: node,
            modified_files: modifies,
            file_count: modifies.length,
          }),
          MAX_RESULT_CHARS,
        );
      },
      {
        name: 'get_pull_request',
        description:
          'Get details of a specific PullRequest node from the graph, ' +
          'including all files it modifies via CHANGES relationships (with diff status and line counts). ' +
          'Use get_pr_file_change to inspect the actual diff or file contents for individual files.',
        schema: z.object({
          prId: z
            .string()
            .describe('PullRequest node ID, e.g. "owner/repo/pr/123"'),
        }),
      },
    ),
    tool(
      async ({ prId }) => {
        // Traverse: PR --CHANGES--> File --incoming(CALLS, IMPORTS, etc.)--> callers
        const modifies = await store.traverse(prId, 'outgoing', 1, 'CHANGES');
        const blastRadius: Record<string, unknown[]> = {};
        for (const rel of modifies) {
          const fileId = rel.relationship.target_id;
          if (!fileId) continue;
          const incoming = await store.traverse(fileId, 'incoming', 2);
          blastRadius[fileId] = incoming;
        }
        return truncate(
          JSON.stringify({
            modified_files: modifies.length,
            blast_radius: blastRadius,
          }),
          MAX_RESULT_CHARS,
        );
      },
      {
        name: 'summarize_pr_changes',
        description:
          'Analyze the blast radius of a pull request by traversing CHANGES relationships ' +
          'to find modified files, then checking what depends on those files. ' +
          'Helps understand the impact of PR changes on the broader codebase.',
        schema: z.object({
          prId: z
            .string()
            .describe('PullRequest node ID, e.g. "owner/repo/pr/123"'),
        }),
      },
    ),
    tool(
      async ({ prId, filePath, version }) => {
        // Find the CHANGES edge for this file
        const changes = await store.traverse(prId, 'outgoing', 1, 'CHANGES');
        const match = changes.find((r) => {
          const props = r.relationship.properties as
            | Record<string, unknown>
            | undefined;
          return props?.path === filePath;
        });

        if (!match) {
          return JSON.stringify({
            error: `No CHANGES edge found for file "${filePath}" in this PR`,
            available_files: changes.map(
              (r) =>
                (r.relationship.properties as Record<string, unknown>)?.path,
            ),
          });
        }

        const edgeProps = match.relationship.properties as Record<
          string,
          unknown
        >;
        const patch = (edgeProps?.patch as string) || null;
        const status = edgeProps?.status as string;

        // Get branch refs from the PR node properties
        const prNode = await store.getNode(prId);
        const baseBranch = (prNode?.properties?.base_branch as string) || null;
        const headBranch = (prNode?.properties?.head_branch as string) || null;

        // Build response based on requested version
        const result: Record<string, unknown> = {
          path: filePath,
          status,
          additions: edgeProps?.additions,
          deletions: edgeProps?.deletions,
        };

        if (version === 'diff' || version === 'all') {
          result.diff = patch ?? '(no patch available)';
        }

        if (version === 'base' || version === 'all') {
          if (status === 'added') {
            result.base_content = null;
          } else if (prClient && baseBranch) {
            result.base_content =
              (await prClient.getFileContent(filePath, baseBranch)) ??
              '(file not found at base branch)';
          } else {
            // Fall back to indexed source when no client available
            const fileId = match.relationship.target_id;
            const source = await store.fetchSource(fileId);
            result.base_content = source?.content ?? '(source not available)';
          }
        }

        if (version === 'new' || version === 'all') {
          if (status === 'removed') {
            result.new_content = null;
          } else if (prClient && headBranch) {
            result.new_content =
              (await prClient.getFileContent(filePath, headBranch)) ??
              '(file not found at head branch)';
          } else {
            result.new_content = '(PR client not available)';
          }
        }

        return truncate(JSON.stringify(result), MAX_SOURCE_CHARS);
      },
      {
        name: 'get_pr_file_change',
        description:
          'Get the diff, base (original), or new (changed) content of a specific file in a PR. ' +
          'Use version "diff" for just the patch, "base" for the original file before the PR, ' +
          '"new" for the file after the PR changes are applied, or "all" for everything. ' +
          'This is the primary tool for inspecting PR file changes — use it instead of load_source ' +
          'when reviewing PRs.',
        schema: z.object({
          prId: z
            .string()
            .describe('PullRequest node ID, e.g. "owner/repo/pr/123"'),
          filePath: z
            .string()
            .describe(
              'File path as shown in the PR (e.g. "src/main.ts"), not the full node ID',
            ),
          version: z
            .enum(['diff', 'base', 'new', 'all'])
            .describe(
              'Which version to return: "diff" for the patch, "base" for the original, ' +
                '"new" for the changed version, "all" for everything',
            ),
        }),
      },
    ),
  ];

  // API-dependent tools (require a live PRClient)
  if (prClient) {
    tools.push(
      tool(
        async ({ number, body, event }) => {
          try {
            await prClient.createReview(
              number,
              body,
              event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
            );
            return JSON.stringify({ success: true, event, number });
          } catch (err) {
            return JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        {
          name: 'submit_review_summary',
          description:
            'Submit a top-level review summary on a pull request via the GitHub/GitLab API. ' +
            'This only posts the review body — inline file comments are not yet supported. ' +
            'Requires a valid token to be configured.',
          schema: z.object({
            number: z.number().describe('PR/MR number'),
            body: z.string().describe('Review body text'),
            event: z
              .enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
              .describe('Review action'),
          }),
        },
      ),
      tool(
        async ({ number, body }) => {
          // Returns a pending-approval payload — the UI renders an interactive
          // widget and the comment is only posted when the user clicks "Post".
          return JSON.stringify({
            type: 'suggest_comment',
            number,
            body,
            pending_approval: true,
          });
        },
        {
          name: 'comment_on_pr',
          description:
            'Post a general comment on a pull request. ' +
            'The comment is NOT posted immediately — it is presented to the user for ' +
            'approval first. The user can edit and then post it.',
          schema: z.object({
            number: z.number().describe('PR/MR number'),
            body: z.string().describe('Comment text'),
          }),
        },
      ),
      tool(
        async ({ number, body, path, line }) => {
          // Presentational tool — returns structured data for the UI to render
          // as an interactive widget. The actual posting happens when the user
          // clicks "Post Comment" in the rendered component.
          return JSON.stringify({
            type: 'suggest_comment',
            number,
            body,
            ...(path ? { path } : {}),
            ...(line ? { line } : {}),
          });
        },
        {
          name: 'suggest_comment',
          description:
            'Suggest a comment to post on a pull request. This does NOT post the comment — ' +
            'it presents the suggestion to the user with a button to post it. ' +
            'Use this when the user asks you to suggest, draft, or compose a comment for a PR. ' +
            'The user can review and edit before posting.',
          schema: z.object({
            number: z.number().describe('PR/MR number'),
            body: z
              .string()
              .describe(
                'The suggested comment body in markdown. Write a clear, constructive comment.',
              ),
            path: z
              .string()
              .optional()
              .describe(
                'File path if this is an inline comment on a specific file',
              ),
            line: z
              .number()
              .optional()
              .describe('Line number if this is an inline comment'),
          }),
        },
      ),
    );
  }

  return tools;
}
