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

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { PRReviewComment } from '../../pr/types';
import { markdownComponents } from '../markdownComponents';
import './ReviewResult.css';

export interface ReviewData {
  summary: string;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments: PRReviewComment[];
}

// eslint-disable-next-line react-refresh/only-export-components
export function parseReviewResult(text: string): ReviewData | null {
  // Try ```json:review first, then any ```json block containing review fields
  const patterns = [
    /```json:review\s*\n([\s\S]*?)```/g,
    /```json\s*\n([\s\S]*?)```/g,
  ];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      try {
        const data = JSON.parse(match[1]);
        // Must have summary + verdict to be a review block (not some other JSON)
        if (data.summary && data.verdict) {
          return {
            summary: data.summary,
            verdict: data.verdict,
            comments: Array.isArray(data.comments) ? data.comments : [],
          };
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

// eslint-disable-next-line react-refresh/only-export-components
export function stripReviewBlock(text: string): string {
  // Remove ```json:review blocks first, then any ```json block that contains review fields
  let result = text.replace(/```json:review\s*\n[\s\S]*?```/, '');
  // Only strip plain ```json blocks if they contain review structure
  result = result.replace(/```json\s*\n([\s\S]*?)```/g, (full, inner) => {
    try {
      const data = JSON.parse(inner);
      if (data.summary && data.verdict) return '';
    } catch {
      /* not valid JSON, keep it */
    }
    return full;
  });
  return result.trim();
}

const VERDICT_LABELS: Record<string, string> = {
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request Changes',
  COMMENT: 'Comment',
};

const VERDICT_COLORS: Record<string, string> = {
  APPROVE: 'var(--success, #22c55e)',
  REQUEST_CHANGES: 'var(--destructive, #ef4444)',
  COMMENT: 'var(--muted-foreground)',
};

/** Extract a user-friendly message from a GitHub API error string */
function friendlyError(raw: string): string {
  // Try to parse the JSON error body from "GitHub API error 422: {...}"
  const jsonMatch = raw.match(/:\s*(\{[\s\S]*\})\s*$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.errors?.length) {
        return parsed.errors.join('. ');
      }
      if (parsed.message) return parsed.message;
    } catch {
      /* fall through */
    }
  }
  return raw;
}

/** Check if the error is a "can't approve own PR" type */
function isOwnPRError(raw: string): boolean {
  return /approve your own/i.test(raw) || /Can not approve/i.test(raw);
}

interface Props {
  review: ReviewData;
  onSubmit?: (data: ReviewData) => Promise<void>;
  onPostAsComment?: (body: string) => Promise<void>;
  submitted?: boolean;
}

export default function ReviewResult({
  review,
  onSubmit,
  onPostAsComment,
  submitted,
}: Props) {
  const [verdict, setVerdict] = useState(review.verdict);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRaw, setErrorRaw] = useState<string | null>(null);
  const [done, setDone] = useState(submitted ?? false);

  const handleSubmit = async () => {
    if (!onSubmit) return;
    setSubmitting(true);
    setError(null);
    setErrorRaw(null);
    try {
      await onSubmit({ ...review, verdict });
      setDone(true);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setErrorRaw(raw);
      setError(friendlyError(raw));
    } finally {
      setSubmitting(false);
    }
  };

  const handlePostAsComment = async () => {
    if (!onPostAsComment) return;
    setSubmitting(true);
    setError(null);
    setErrorRaw(null);
    try {
      // Build a formatted comment body from the review
      const parts: string[] = [];
      parts.push(`## Code Review\n\n${review.summary}`);
      if (review.comments.length > 0) {
        parts.push('\n\n### Comments\n');
        for (const c of review.comments) {
          const loc = c.path
            ? `**${c.path}${c.line ? `:${c.line}` : ''}**`
            : '';
          parts.push(`- ${loc}${loc ? ' — ' : ''}${c.body}`);
        }
      }
      await onPostAsComment(parts.join('\n'));
      setDone(true);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setErrorRaw(raw);
      setError(friendlyError(raw));
    } finally {
      setSubmitting(false);
    }
  };

  const showCommentFallback = !!(
    error &&
    errorRaw &&
    (isOwnPRError(errorRaw) || errorRaw.includes('422')) &&
    onPostAsComment
  );

  return (
    <div className="review-result">
      <div className="review-result-header">
        <span
          className="review-verdict-badge"
          style={{ backgroundColor: VERDICT_COLORS[review.verdict] }}
        >
          {VERDICT_LABELS[review.verdict]}
        </span>
        <span className="review-comment-count">
          {review.comments.length}{' '}
          {review.comments.length === 1 ? 'comment' : 'comments'}
        </span>
      </div>

      <div className="review-summary">
        <ReactMarkdown components={markdownComponents}>
          {review.summary}
        </ReactMarkdown>
      </div>

      {review.comments.length > 0 && (
        <div className="review-comments">
          <h5 className="review-comments-title">Inline Comments</h5>
          {review.comments.map((c, i) => (
            <div key={i} className="review-comment-item">
              {c.path && (
                <div className="review-comment-location">
                  <span className="review-comment-path">{c.path}</span>
                  {c.line && (
                    <span className="review-comment-line">:{c.line}</span>
                  )}
                </div>
              )}
              <div className="review-comment-body">
                <ReactMarkdown components={markdownComponents}>
                  {c.body}
                </ReactMarkdown>
              </div>
            </div>
          ))}
        </div>
      )}

      {onSubmit && !done && (
        <div className="review-submit-section">
          <div className="review-verdict-selector">
            <label>Submit as:</label>
            <select
              value={verdict}
              onChange={(e) =>
                setVerdict(e.target.value as ReviewData['verdict'])
              }
              disabled={submitting}
            >
              <option value="COMMENT">Comment</option>
              <option value="APPROVE">Approve</option>
              <option value="REQUEST_CHANGES">Request Changes</option>
            </select>
          </div>
          <button
            className="review-submit-btn"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Submitting...' : 'Submit Review'}
          </button>
          {error && (
            <div className="review-submit-error">
              {error}
              {showCommentFallback && (
                <button
                  className="review-fallback-btn"
                  onClick={handlePostAsComment}
                  disabled={submitting}
                >
                  Post as Comment Instead
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {done && (
        <div className="review-submitted-badge">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Review submitted
        </div>
      )}
    </div>
  );
}
