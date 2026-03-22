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

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  markdownComponents,
  ReviewResult,
  parseReviewResult,
  stripReviewBlock,
  type ReviewData,
} from '@opentrace/components/chat';
import type { PRDetail, PRFileDiff } from '../pr/types';
import type { PRClient } from '../pr/client';
import type { GraphStore } from '../store/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { runPRReview } from '../pr/reviewRunner';
import './PRDetailPanel.css';

interface Props {
  pr: PRDetail;
  onBack: () => void;
  onIndex: (pr: PRDetail) => Promise<void>;
  /** Called to re-select/focus the PR node in the graph viewer */
  onSelectInGraph?: (pr: PRDetail) => void;
  /** If provided, enables the "Run Review" button */
  llm?: BaseChatModel | null;
  store?: GraphStore | null;
  prClient?: PRClient | null;
  /** Switch to chat tab with PR context pre-seeded */
  onChatWithPR?: (prompt: string) => void;
}

function FileDiffRow({ file }: { file: PRFileDiff }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="pr-file-row">
      <button
        className="pr-file-header"
        onClick={() => file.patch && setExpanded(!expanded)}
      >
        <span className={`pr-file-status pr-file-status-${file.status}`}>
          {(file.status?.[0] ?? '?').toUpperCase()}
        </span>
        <span className="pr-file-path">{file.path}</span>
        <span className="pr-file-stats">
          {file.additions > 0 && (
            <span className="pr-stat-add">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="pr-stat-del">-{file.deletions}</span>
          )}
        </span>
        {file.patch && (
          <span className="pr-file-expand">
            {expanded ? '\u25B4' : '\u25BE'}
          </span>
        )}
      </button>
      {expanded && file.patch && (
        <pre className="pr-file-patch">{file.patch}</pre>
      )}
    </div>
  );
}

export default function PRDetailPanel({
  pr,
  onBack,
  onIndex,
  onSelectInGraph,
  llm,
  store,
  prClient,
  onChatWithPR,
}: Props) {
  const [indexing, setIndexing] = useState(false);
  const [indexed, setIndexed] = useState(false);

  // Review state
  const [reviewing, setReviewing] = useState(false);
  const [reviewSteps, setReviewSteps] = useState<string[]>([]);
  const [reviewResult, setReviewResult] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const canReview = !!(llm && store);

  // Check if this PR is already indexed in the graph
  useEffect(() => {
    if (!store || !prClient) return;
    const prId = `${prClient.meta.owner}/${prClient.meta.repo}/pr/${pr.number}`;
    store
      .getNode(prId)
      .then((node) => {
        if (node) setIndexed(true);
      })
      .catch(() => {
        /* ignore */
      });
  }, [store, prClient, pr.number]);

  const handleIndex = async () => {
    setIndexing(true);
    try {
      await onIndex(pr);
      setIndexed(true);
    } finally {
      setIndexing(false);
    }
  };

  const handleRunReview = async () => {
    if (!llm || !store) return;

    // Auto-index if not yet indexed — the review agent needs PR data in the graph
    if (!indexed) {
      setIndexing(true);
      try {
        await onIndex(pr);
        setIndexed(true);
      } catch (err) {
        setReviewError(
          `Failed to index PR: ${err instanceof Error ? err.message : String(err)}`,
        );
        setIndexing(false);
        return;
      }
      setIndexing(false);
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setReviewing(true);
    setReviewSteps([]);
    setReviewResult(null);
    setReviewError(null);

    const meta = prClient
      ? { owner: prClient.meta.owner, repo: prClient.meta.repo }
      : { owner: 'unknown', repo: 'unknown' };

    try {
      const result = await runPRReview(llm, store, prClient ?? null, pr, meta, {
        onProgress: (step) => setReviewSteps((prev) => [...prev, step]),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setReviewResult(result);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setReviewError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setReviewing(false);
    }
  };

  const handleCancelReview = () => {
    abortRef.current?.abort();
    setReviewing(false);
  };

  const handleSubmitReview = async (data: ReviewData) => {
    if (!prClient) throw new Error('No PR client configured');
    await prClient.createReview(
      pr.number,
      data.summary,
      data.verdict,
      data.comments.filter((c) => c.path),
      pr.files, // pass diffs so line numbers can be validated against patches
    );
  };

  const handlePostAsComment = async (body: string) => {
    if (!prClient) throw new Error('No PR client configured');
    await prClient.postComment(pr.number, body);
  };

  const totalAdditions = pr.files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = pr.files.reduce((s, f) => s + f.deletions, 0);

  // Parse structured review if available
  const parsedReview = reviewResult ? parseReviewResult(reviewResult) : null;
  const reviewMarkdown = reviewResult
    ? parsedReview
      ? stripReviewBlock(reviewResult)
      : reviewResult
    : null;

  return (
    <div className="pr-detail-panel">
      <div className="pr-detail-nav">
        <button className="pr-back-btn" onClick={onBack}>
          &larr; Back to list
        </button>
      </div>

      <div className="pr-detail-header">
        <h3 className="pr-detail-title">
          <span className="pr-detail-number">#{pr.number}</span>
          {pr.title}
        </h3>
        <div className="pr-detail-meta">
          <span className="pr-detail-author">{pr.author}</span>
          <span className="pr-detail-branches">
            {pr.head_branch} &rarr; {pr.base_branch}
          </span>
          <span className="pr-detail-stats">
            <span className="pr-stat-add">+{totalAdditions}</span>
            <span className="pr-stat-del">-{totalDeletions}</span>
            <span className="pr-detail-file-count">
              {pr.files.length} {pr.files.length === 1 ? 'file' : 'files'}
            </span>
          </span>
        </div>
      </div>

      <div className="pr-detail-actions">
        <button
          className={`pr-action-btn pr-action-index ${indexed ? 'pr-action-indexed' : ''}`}
          onClick={indexed ? () => onSelectInGraph?.(pr) : handleIndex}
          disabled={indexing}
        >
          {indexed
            ? 'Indexed \u2714'
            : indexing
              ? 'Indexing...'
              : 'Index into Graph'}
        </button>
        {canReview && (
          <button
            className="pr-action-btn pr-action-review"
            onClick={handleRunReview}
            disabled={reviewing}
          >
            {reviewing
              ? 'Reviewing...'
              : reviewResult
                ? 'Re-run Review'
                : 'Run Review'}
          </button>
        )}
        {reviewing && (
          <button
            className="pr-action-btn pr-action-cancel"
            onClick={handleCancelReview}
          >
            Cancel
          </button>
        )}
        {onChatWithPR && (
          <button
            className="pr-action-btn pr-action-chat"
            onClick={() => {
              const files = pr.files.map((f) => f.path).join(', ');
              const prompt =
                `I'm looking at PR #${pr.number}: "${pr.title}" by ${pr.author} ` +
                `(${pr.head_branch} → ${pr.base_branch}, ${pr.files.length} files: ${files}). ` +
                `Help me understand these changes.`;
              onChatWithPR(prompt);
            }}
          >
            Chat with PR
          </button>
        )}
        <a
          className="pr-action-btn pr-action-open"
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in {pr.url.includes('gitlab') ? 'GitLab' : 'GitHub'}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      </div>

      {/* ── Review progress ── */}
      {reviewing && (
        <div className="pr-review-progress">
          <div className="pr-review-progress-header">
            <span className="pr-review-spinner" />
            <span>Reviewing PR...</span>
          </div>
          {reviewSteps.length > 0 && (
            <div className="pr-review-steps">
              {reviewSteps.slice(-5).map((step, i) => (
                <div
                  key={i}
                  className={`pr-review-step ${i === reviewSteps.slice(-5).length - 1 ? 'current' : ''}`}
                >
                  {i === reviewSteps.slice(-5).length - 1 ? (
                    <span className="pr-review-step-spinner" />
                  ) : (
                    <svg
                      className="pr-review-step-check"
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
                  <span>{step}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Review error ── */}
      {reviewError && (
        <div className="pr-review-error">Review failed: {reviewError}</div>
      )}

      {/* ── Review result ── */}
      {reviewResult && !reviewing && (
        <div className="pr-review-result">
          <div className="pr-review-result-header">
            <h4>Code Review</h4>
          </div>
          {reviewMarkdown && (
            <div className="pr-review-result-body message-content">
              <div className="markdown-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {reviewMarkdown}
                </ReactMarkdown>
              </div>
            </div>
          )}
          {parsedReview ? (
            <ReviewResult
              review={parsedReview}
              onSubmit={prClient ? handleSubmitReview : undefined}
              onPostAsComment={prClient ? handlePostAsComment : undefined}
            />
          ) : (
            <ReviewResult
              review={{
                summary: reviewResult!,
                verdict: 'COMMENT',
                comments: [],
              }}
              onSubmit={prClient ? handleSubmitReview : undefined}
              onPostAsComment={prClient ? handlePostAsComment : undefined}
            />
          )}
          {onChatWithPR && (
            <button
              className="pr-action-btn pr-action-chat pr-chat-with-review-btn"
              onClick={() => {
                const reviewSummary = parsedReview?.summary ?? reviewResult!;
                const prompt =
                  `I just ran a code review on PR #${pr.number}: "${pr.title}". ` +
                  `Here's the review summary:\n\n${reviewSummary}\n\n` +
                  `Let's discuss the findings and any follow-up actions.`;
                onChatWithPR(prompt);
              }}
            >
              Chat with Review
            </button>
          )}
        </div>
      )}

      {pr.body && (
        <div className="pr-detail-body">
          <div className="pr-body-content message-content">
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {pr.body}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}

      <div className="pr-detail-files">
        <div className="pr-files-header">
          <span>Changed files ({pr.files.length})</span>
        </div>
        {pr.files.map((file) => (
          <FileDiffRow key={file.path} file={file} />
        ))}
      </div>
    </div>
  );
}
