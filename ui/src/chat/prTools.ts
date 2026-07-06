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

/**
 * LangChain tools for PR/MR operations in the chat agent.
 */

import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { GraphStore } from '../store/types';
import type { PRClient } from '../pr/client';

const MAX_RESULT_CHARS = 16_000;
/** Per-field budgets for get_pr_file_change. Each field is bounded
 *  independently and flagged when cut — never truncate the combined JSON
 *  mid-stream, or the model reviews half a payload without knowing it. */
const MAX_DIFF_CHARS = 12_000;
const MAX_CONTENT_CHARS = 16_000;
/** Safety net for the combined get_pr_file_change payload. */
const MAX_FILE_CHANGE_CHARS = 48_000;
/** Max compact file entries returned by get_pull_request. */
const MAX_FILE_ENTRIES = 300;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n...[truncated, ${text.length} chars total]`;
}

/**
 * Slice file content to a 1-based inclusive line range, numbered cat -n
 * style so the model can cite exact new-file line numbers, bounded by a
 * character budget. Reports the range served and where to resume.
 */
function packContent(
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
  budget: number,
): {
  text: string;
  lines: string;
  truncated: boolean;
  next_start_line?: number;
} {
  const all = content.split('\n');
  const total = all.length;
  const start = Math.min(Math.max(1, startLine ?? 1), total);
  const end = Math.min(total, endLine && endLine >= start ? endLine : total);
  const out: string[] = [];
  let used = 0;
  let last = start - 1;
  for (let i = start; i <= end; i++) {
    const line = `${String(i).padStart(5)}\t${all[i - 1]}`;
    if (used + line.length + 1 > budget) break;
    out.push(line);
    used += line.length + 1;
    last = i;
  }
  const truncated = last < end;
  return {
    text: out.join('\n'),
    lines: `${start}-${last} of ${total}`,
    truncated,
    ...(truncated ? { next_start_line: last + 1 } : {}),
  };
}

/** Read a string property from a node's properties bag. */
function strProp(
  props: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = props?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
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

        const modifies = await store.traverse(prId, 'outgoing', 1, 'CHANGES');
        // Compact entries — one small object per file so even huge PRs
        // return a complete file list instead of a truncated JSON blob.
        const files = modifies.map((r) => {
          const p = (r.relationship.properties ?? {}) as Record<
            string,
            unknown
          >;
          return {
            path: p.path,
            status: p.status,
            additions: p.additions,
            deletions: p.deletions,
          };
        });
        const omitted = Math.max(0, files.length - MAX_FILE_ENTRIES);
        return truncate(
          JSON.stringify({
            pr: node,
            files: files.slice(0, MAX_FILE_ENTRIES),
            file_count: files.length,
            ...(omitted
              ? {
                  files_omitted: omitted,
                  note: `Showing first ${MAX_FILE_ENTRIES} of ${files.length} files`,
                }
              : {}),
          }),
          MAX_RESULT_CHARS,
        );
      },
      {
        name: 'get_pull_request',
        description:
          'Get details of a specific PullRequest node from the graph, ' +
          'with a complete compact list of every changed file (path, status, +/- line counts). ' +
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
        const blastRadius: Record<string, unknown> = {};
        // Compact per-file summary (count + sample) so large PRs don't
        // overflow into mid-JSON truncation.
        const scanned = modifies.slice(0, 100);
        for (const rel of scanned) {
          const fileId = rel.relationship.target_id;
          if (!fileId) continue;
          const incoming = await store.traverse(fileId, 'incoming', 2);
          blastRadius[fileId] = {
            dependents: incoming.length,
            sample: incoming
              .slice(0, 10)
              .map((d) => `${d.node.type}:${d.node.name || d.node.id}`),
          };
        }
        return truncate(
          JSON.stringify({
            modified_files: modifies.length,
            ...(modifies.length > scanned.length
              ? {
                  note: `Blast radius computed for first ${scanned.length} of ${modifies.length} files`,
                }
              : {}),
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
      async ({ prId, filePath, version, startLine, endLine }) => {
        // Find the CHANGES edge for this file
        const changes = await store.traverse(prId, 'outgoing', 1, 'CHANGES');
        const match = changes.find((r) => {
          const props = r.relationship.properties as
            | Record<string, unknown>
            | undefined;
          return props?.path === filePath;
        });

        if (!match) {
          return truncate(
            JSON.stringify({
              error: `No CHANGES edge found for file "${filePath}" in this PR`,
              available_files: changes.map(
                (r) =>
                  (r.relationship.properties as Record<string, unknown>)?.path,
              ),
            }),
            MAX_RESULT_CHARS,
          );
        }

        const edgeProps = match.relationship.properties as Record<
          string,
          unknown
        >;
        const patch = (edgeProps?.patch as string) || null;
        const status = edgeProps?.status as string;
        const previousPath = (edgeProps?.previous_path as string) || null;

        // Resolve refs from the PR node. Prefer immutable SHAs — branch
        // names move after indexing, and fork head branches don't exist
        // in the base repo at all.
        const prNode = await store.getNode(prId);
        const prProps = prNode?.properties as
          | Record<string, unknown>
          | undefined;
        const baseRef = strProp(
          prProps,
          'baseSha',
          'base_sha',
          'baseBranch',
          'base_branch',
        );
        const headRef = strProp(
          prProps,
          'headSha',
          'head_sha',
          'headBranch',
          'head_branch',
        );
        const headRepo = strProp(prProps, 'headRepo', 'head_repo');

        // Build response based on requested version. Every content field
        // is bounded and flagged individually — a silently truncated blob
        // makes the model review code it never saw.
        const result: Record<string, unknown> = {
          path: filePath,
          status,
          additions: edgeProps?.additions,
          deletions: edgeProps?.deletions,
          ...(previousPath ? { previous_path: previousPath } : {}),
        };

        if (version === 'diff' || version === 'all') {
          if (!patch) {
            result.diff =
              '(no patch available — file may be binary or the diff was too large for the provider)';
          } else {
            result.diff = truncate(patch, MAX_DIFF_CHARS);
            if (patch.length > MAX_DIFF_CHARS) {
              result.diff_truncated = true;
              result.diff_note =
                'Diff truncated. Use version "new" with startLine/endLine to read the full changed regions.';
            }
          }
        }

        if (version === 'base' || version === 'all') {
          const basePath =
            status === 'renamed' && previousPath ? previousPath : filePath;
          let content: string | null = null;
          if (status === 'added') {
            result.base_content = null;
          } else {
            if (prClient && baseRef) {
              content = await prClient.getFileContent(basePath, baseRef);
            }
            if (content == null) {
              // Fall back to indexed source when no client/ref available
              const fileId = match.relationship.target_id;
              const source = await store.fetchSource(fileId);
              content = source?.content ?? null;
              if (content != null) {
                result.base_content_note =
                  'Served from the indexed snapshot, not the PR base commit — may be stale.';
              }
            }
            if (content == null) {
              result.base_content = '(base content not available)';
            } else {
              const packed = packContent(
                content,
                startLine,
                endLine,
                MAX_CONTENT_CHARS,
              );
              result.base_content = packed.text;
              result.base_content_lines = packed.lines;
              if (packed.truncated) {
                result.base_content_truncated = true;
                result.base_content_note = `Call again with startLine=${packed.next_start_line} to continue.`;
              }
            }
          }
        }

        if (version === 'new' || version === 'all') {
          if (status === 'removed') {
            result.new_content = null;
          } else if (!prClient || !headRef) {
            result.new_content = '(PR client not available)';
          } else {
            let content = await prClient.getFileContent(filePath, headRef);
            if (content == null && headRepo) {
              // Fork PR — head commit lives in the fork repo
              content = await prClient.getFileContent(
                filePath,
                headRef,
                headRepo,
              );
            }
            if (content == null) {
              result.new_content = `(file not found at PR head "${headRef}")`;
            } else {
              const packed = packContent(
                content,
                startLine,
                endLine,
                MAX_CONTENT_CHARS,
              );
              result.new_content = packed.text;
              result.new_content_lines = packed.lines;
              if (packed.truncated) {
                result.new_content_truncated = true;
                result.new_content_note = `Call again with startLine=${packed.next_start_line} to continue.`;
              }
            }
          }
        }

        return truncate(JSON.stringify(result), MAX_FILE_CHANGE_CHARS);
      },
      {
        name: 'get_pr_file_change',
        description:
          'Get the diff, base (original), or new (changed) content of a specific file in a PR. ' +
          'Use version "diff" for just the patch, "base" for the original file before the PR, ' +
          '"new" for the file after the PR changes are applied, or "all" for everything. ' +
          'Content is returned with 1-based line numbers (use these exact numbers for review comments). ' +
          'Large files are paged: when a *_truncated flag appears, call again with startLine set to the ' +
          'reported next_start_line. ' +
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
          startLine: z
            .number()
            .optional()
            .describe(
              'First line (1-based, inclusive) of base/new content to return. ' +
                'Use to page through files flagged *_truncated.',
            ),
          endLine: z
            .number()
            .optional()
            .describe(
              'Last line (1-based, inclusive) of base/new content to return',
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
