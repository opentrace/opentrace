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

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from '../markdownComponents';
import './SuggestCommentResult.css';

export interface SuggestCommentData {
  number: number;
  body: string;
  path?: string;
  line?: number;
}

// eslint-disable-next-line react-refresh/only-export-components
export function parseSuggestComment(raw: string): SuggestCommentData | null {
  try {
    const data = JSON.parse(raw);
    if (data.type === 'suggest_comment' && data.number && data.body) {
      return {
        number: data.number,
        body: data.body,
        path: data.path,
        line: data.line,
      };
    }
  } catch {
    /* not valid JSON */
  }
  return null;
}

interface Props {
  comment: SuggestCommentData;
  onPost?: (number: number, body: string) => Promise<void>;
}

export default function SuggestCommentResult({ comment, onPost }: Props) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height =
        textareaRef.current.scrollHeight + 'px';
    }
  }, [editing]);

  const handlePost = async () => {
    if (!onPost) return;
    setPosting(true);
    setError(null);
    try {
      await onPost(comment.number, body);
      setPosted(true);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="suggest-comment">
      <div className="suggest-comment-header">
        <svg
          className="suggest-comment-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="suggest-comment-label">
          Suggested comment on PR #{comment.number}
        </span>
        {comment.path && (
          <span className="suggest-comment-location">
            {comment.path}
            {comment.line ? `:${comment.line}` : ''}
          </span>
        )}
      </div>

      <div className="suggest-comment-body">
        {editing ? (
          <textarea
            ref={textareaRef}
            className="suggest-comment-editor"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = e.target.scrollHeight + 'px';
            }}
          />
        ) : (
          <div className="suggest-comment-preview markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {body}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {!posted && (
        <div className="suggest-comment-actions">
          {editing ? (
            <button
              className="suggest-comment-btn suggest-comment-done"
              onClick={() => setEditing(false)}
            >
              Done editing
            </button>
          ) : (
            <button
              className="suggest-comment-btn suggest-comment-edit"
              onClick={() => setEditing(true)}
              disabled={posting}
            >
              Edit
            </button>
          )}
          {onPost && (
            <button
              className="suggest-comment-btn suggest-comment-post"
              onClick={handlePost}
              disabled={posting || !body.trim()}
            >
              {posting ? 'Posting...' : 'Post Comment'}
            </button>
          )}
        </div>
      )}

      {error && <div className="suggest-comment-error">{error}</div>}

      {posted && (
        <div className="suggest-comment-posted">
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
          Comment posted
        </div>
      )}
    </div>
  );
}
