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
import type { PRReviewComment } from '../types';
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

/** Check if the error is a missing/invalid token error */
function isTokenError(raw: string): boolean {
  return (
    /token required/i.test(raw) ||
    /bad credentials/i.test(raw) ||
    /401\b/.test(raw) ||
    /requires authentication/i.test(raw)
  );
}

type TokenProvider = 'github' | 'gitlab' | 'bitbucket' | 'azuredevops';

const TOKEN_PROVIDER_LABEL: Record<TokenProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azuredevops: 'Azure DevOps',
};

const TOKEN_PROVIDER_HELP: Record<TokenProvider, string> = {
  github: 'https://github.com/settings/tokens',
  gitlab: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  bitbucket: 'https://bitbucket.org/account/settings/app-passwords/',
  azuredevops:
    'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate',
};

interface Props {
  review: ReviewData;
  onSubmit?: (data: ReviewData) => Promise<void>;
  onPostAsComment?: (body: string) => Promise<void>;
  submitted?: boolean;
  /** Provider for the repo this review targets — controls the "Get a token" help link. */
  provider?: TokenProvider;
  /**
   * Called when the user enters a token via the inline prompt that appears after a
   * "Token required" submit failure. Implementer should persist the token and update
   * any in-memory client so the next submit retry succeeds.
   */
  onProvideToken?: (token: string) => Promise<void> | void;
  /**
   * If true, no auth token is configured for the target host — show the token entry
   * form proactively (instead of waiting for the user to click Submit and fail).
   */
  tokenMissing?: boolean;
}

export default function ReviewResult({
  review,
  onSubmit,
  onPostAsComment,
  submitted,
  provider,
  onProvideToken,
  tokenMissing,
}: Props) {
  const [verdict, setVerdict] = useState(review.verdict);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRaw, setErrorRaw] = useState<string | null>(null);
  const [done, setDone] = useState(submitted ?? false);
  const [tokenInput, setTokenInput] = useState('');
  const [savingToken, setSavingToken] = useState(false);

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

  const handleSaveTokenAndRetry = async () => {
    if (!onProvideToken || !tokenInput.trim()) return;
    setSavingToken(true);
    try {
      await onProvideToken(tokenInput.trim());
      setTokenInput('');
      // Clear the error so the prompt collapses; then retry submit.
      setError(null);
      setErrorRaw(null);
      await handleSubmit();
    } finally {
      setSavingToken(false);
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

  const errorIsTokenIssue = !!(
    error &&
    errorRaw &&
    isTokenError(errorRaw) &&
    onProvideToken
  );

  // Show the token form when (a) no token is configured for this host yet, or
  // (b) the last submit failed because of an auth/token problem.
  const showTokenForm =
    !!onProvideToken && (errorIsTokenIssue || !!tokenMissing);

  const providerLabel = provider ? TOKEN_PROVIDER_LABEL[provider] : 'Git host';
  const providerHelpUrl = provider ? TOKEN_PROVIDER_HELP[provider] : null;
  const tokenNoun =
    provider === 'bitbucket' ? 'App Password' : 'Personal Access Token';

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
              disabled={submitting || savingToken}
            >
              <option value="COMMENT">Comment</option>
              <option value="APPROVE">Approve</option>
              <option value="REQUEST_CHANGES">Request Changes</option>
            </select>
          </div>

          {showTokenForm ? (
            <div className="review-submit-error">
              <div className="review-token-prompt-header">
                {errorIsTokenIssue
                  ? `That ${providerLabel} ${tokenNoun} didn't work — try another.`
                  : `Add a ${providerLabel} ${tokenNoun} to submit reviews.`}
              </div>
              <div className="review-token-prompt-row">
                <input
                  type="password"
                  className="review-token-input"
                  placeholder={`Paste ${providerLabel} ${tokenNoun}`}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  disabled={savingToken || submitting}
                  autoFocus={errorIsTokenIssue}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      tokenInput.trim() &&
                      !savingToken
                    ) {
                      void handleSaveTokenAndRetry();
                    }
                  }}
                />
                <button
                  type="button"
                  className="review-submit-btn"
                  onClick={() => void handleSaveTokenAndRetry()}
                  disabled={!tokenInput.trim() || savingToken || submitting}
                >
                  {savingToken || submitting
                    ? 'Submitting...'
                    : 'Save & Submit'}
                </button>
              </div>
              {providerHelpUrl && (
                <div className="review-token-prompt-hint">
                  Token is stored locally in your browser.{' '}
                  <a
                    href={providerHelpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Create one &rarr;
                  </a>
                </div>
              )}
            </div>
          ) : (
            <>
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
            </>
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
