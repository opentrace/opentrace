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

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ToolCallPart } from './types';
import {
  parseSearchResult,
  parseListNodesResult,
  parseGetNodeResult,
  parseTraverseResult,
} from './results/parsers';
import { markdownComponents } from './markdownComponents';
import NodeListResult from './results/NodeListResult';
import GetNodeResultView from './results/GetNodeResult';
import TraverseResultView from './results/TraverseResult';
import ReviewResult, {
  parseReviewResult,
  stripReviewBlock,
  type ReviewData,
} from './results/ReviewResult';
import SuggestCommentResult, {
  parseSuggestComment,
} from './results/SuggestCommentResult';
import './results/results.css';

interface Props {
  part: ToolCallPart;
  onNodeSelect?: (nodeId: string) => void;
  onSubmitReview?: (data: ReviewData) => Promise<void>;
  onPostComment?: (number: number, body: string) => Promise<void>;
}

/** User-friendly display names */
const TOOL_NAMES: Record<string, string> = {
  search_graph: 'Search Graph',
  list_nodes: 'List Nodes',
  get_node: 'Get Node',
  traverse_graph: 'Traverse Graph',
  load_source: 'Load Source',
  explore_node: 'Explore Node',
  grep: 'Source Grep',
  list_pull_requests: 'List Pull Requests',
  get_pull_request: 'Get Pull Request',
  summarize_pr_changes: 'Summarize PR Changes',
  review_pull_request: 'Review Pull Request',
  comment_on_pr: 'Comment on PR',
};

/** Tools that are actually sub-agents — rendered with distinct styling */
const AGENT_TOOLS = new Set<string>();

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const RAW_DISPLAY_LIMIT = 2000;

function tryPrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

/** Renders raw JSON as a fallback when custom parsing fails */
function RawResult({ result }: { result: string }) {
  const pretty = tryPrettyJson(result);
  const truncated = pretty.length > RAW_DISPLAY_LIMIT;
  const display = truncated
    ? pretty.slice(0, RAW_DISPLAY_LIMIT) + '\n\u2026[truncated]'
    : pretty;

  return <pre className="tool-section-content">{display}</pre>;
}

/** For agent tools, pull out the top-level "query" arg for inline display */
function extractQuery(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson);
    if (typeof parsed.query === 'string') return parsed.query;
  } catch {
    /* ignore */
  }
  return null;
}

/** Keep only the active step + up to N most-recent completed steps */
function trimSteps(steps: string[], isActive: boolean): string[] {
  const MAX_OLD = 3;
  if (steps.length <= MAX_OLD + (isActive ? 1 : 0)) return steps;
  // Active step is always the last element
  return isActive ? steps.slice(-(MAX_OLD + 1)) : steps.slice(-MAX_OLD);
}

/** Extract the "summary" field from a JSON agent result (best-effort). */
function extractSummary(result: string): string {
  try {
    // Result may be a raw JSON string or wrapped in a fenced code block
    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : result;
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed.summary === 'string' && parsed.summary) {
      return parsed.summary;
    }
  } catch {
    /* ignore */
  }
  return 'Done.';
}

export default function ChatToolCall({
  part,
  onNodeSelect,
  onSubmitReview,
  onPostComment,
}: Props) {
  const displayName = TOOL_NAMES[part.name] ?? part.name;
  const isAgent = AGENT_TOOLS.has(part.name);
  const duration = part.endTime
    ? formatDuration(part.endTime - part.startTime)
    : null;
  const prettyArgs = part.args ? tryPrettyJson(part.args) : '';
  const agentQuery = isAgent ? extractQuery(part.args) : null;

  // Attempt structured parsing per tool type
  const customResult = useMemo(() => {
    if (!part.result || part.status === 'error') return null;

    switch (part.name) {
      case 'search_graph': {
        const nodes = parseSearchResult(part.result);
        return nodes ? (
          <NodeListResult nodes={nodes} onNodeSelect={onNodeSelect} />
        ) : null;
      }
      case 'list_nodes': {
        const nodes = parseListNodesResult(part.result);
        return nodes ? (
          <NodeListResult nodes={nodes} onNodeSelect={onNodeSelect} />
        ) : null;
      }
      case 'get_node': {
        const node = parseGetNodeResult(part.result);
        return node ? (
          <GetNodeResultView node={node} onNodeSelect={onNodeSelect} />
        ) : null;
      }
      case 'traverse_graph': {
        const entries = parseTraverseResult(part.result);
        return entries ? (
          <TraverseResultView entries={entries} onNodeSelect={onNodeSelect} />
        ) : null;
      }
      case 'suggest_comment':
      case 'comment_on_pr': {
        const comment = parseSuggestComment(part.result);
        return comment ? (
          <SuggestCommentResult comment={comment} onPost={onPostComment} />
        ) : null;
      }
      default:
        return null;
    }
  }, [part.name, part.result, part.status, onNodeSelect, onPostComment]);

  // Wrench icon for tools, sparkle icon for agents
  const icon = isAgent ? (
    <svg
      className="tool-call-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v2m0 14v2m-7-9H3m18 0h-2m-1.5-6.5L16 7m-8 10-1.5 1.5M19.5 17.5 18 16M6 7 4.5 5.5" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg
      className="tool-call-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );

  return (
    <details
      className={`chat-tool-call${isAgent ? ' agent-call' : ''}`}
      open={isAgent || part.status === 'active' || !!customResult}
    >
      <summary className="tool-call-summary">
        {icon}
        <span className="tool-call-name">
          {isAgent ? `Agent: ${displayName}` : displayName}
        </span>
        {part.status === 'active' && (
          <span className="tool-status-badge active">
            <span className="tool-status-spinner" />
            {isAgent ? 'Thinking' : 'Running'}
          </span>
        )}
        {part.status === 'success' && (
          <span className="tool-status-badge success">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Done
          </span>
        )}
        {part.status === 'error' && (
          <span className="tool-status-badge error">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            Error
          </span>
        )}
        {duration && <span className="tool-duration">{duration}</span>}
      </summary>
      <div className="tool-call-details">
        {/* Agent: show query inline */}
        {isAgent && agentQuery && (
          <div className="agent-query">{agentQuery}</div>
        )}
        {/* Agent progress steps — active + up to 3 recent */}
        {isAgent &&
          part.progressSteps &&
          part.progressSteps.length > 0 &&
          (() => {
            const visible = trimSteps(
              part.progressSteps,
              part.status === 'active',
            );
            const hidden = part.progressSteps.length - visible.length;
            return (
              <div className="agent-progress">
                {hidden > 0 && (
                  <div className="agent-progress-step muted">
                    <span className="agent-step-label">
                      +{hidden} earlier step{hidden > 1 ? 's' : ''}
                    </span>
                  </div>
                )}
                {visible.map((step, i) => {
                  const isLast = i === visible.length - 1;
                  const isCurrent = isLast && part.status === 'active';
                  return (
                    <div
                      key={i}
                      className={`agent-progress-step${isCurrent ? ' current' : ''}`}
                    >
                      {isCurrent ? (
                        <span className="agent-step-spinner" />
                      ) : (
                        <svg
                          className="agent-step-check"
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                      <span className="agent-step-label">{step}</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        {/* Agent: show result summary when complete */}
        {isAgent &&
          part.status !== 'active' &&
          part.result &&
          (() => {
            // Code reviewer returns prose + structured review — render fully
            if (part.name === 'code_reviewer') {
              const reviewData = parseReviewResult(part.result);
              const strippedText = reviewData
                ? stripReviewBlock(part.result)
                : part.result;
              return (
                <>
                  <div className="agent-result markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {strippedText}
                    </ReactMarkdown>
                  </div>
                  {reviewData && (
                    <ReviewResult
                      review={reviewData}
                      onSubmit={onSubmitReview}
                    />
                  )}
                </>
              );
            }
            // Other agents return raw JSON — show summary + collapsible raw data
            return (
              <>
                <div className="agent-result-summary">
                  {extractSummary(part.result)}
                </div>
                <details className="tool-section">
                  <summary className="tool-section-label">Raw data</summary>
                  <RawResult result={part.result} />
                </details>
              </>
            );
          })()}
        {/* Non-agent tools: keep existing collapsible sections */}
        {!isAgent && prettyArgs && (
          <details className="tool-section">
            <summary className="tool-section-label">Arguments</summary>
            <pre className="tool-section-content">{prettyArgs}</pre>
          </details>
        )}
        {!isAgent && part.result && (
          <details className="tool-section" open={!!customResult}>
            <summary className="tool-section-label">
              Result
              {!customResult && part.result.length > 500 && (
                <span className="tool-size-hint">
                  {formatSize(part.result.length)}
                </span>
              )}
            </summary>
            <div className={customResult ? 'tool-section-custom' : ''}>
              {customResult ?? <RawResult result={part.result} />}
            </div>
          </details>
        )}
      </div>
    </details>
  );
}
