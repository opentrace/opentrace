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

import { useEffect, useState } from 'react';
import type { PRClient } from '../pr/client';
import type { PRSummary, PRDetail } from '../pr/types';
import type { GraphStore } from '../store/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { indexPRIntoGraph } from '../pr/indexer';
import PRDetailPanel from './PRDetailPanel';
import { OpenTraceLogo } from './OpenTraceLogo';
import './PRListPanel.css';

/**
 * Parse user input that is either a bare PR/MR number or a full URL.
 * Returns the extracted number, or null if unparseable.
 */
function parsePRInput(input: string): number | null {
  const trimmed = input.trim().replace(/^#/, '');
  // Plain number (with optional leading #)
  const num = parseInt(trimmed, 10);
  if (/^\d+$/.test(trimmed) && num > 0) return num;

  // GitHub: /pull/123
  const gh = trimmed.match(/\/pull\/(\d+)/);
  if (gh) return parseInt(gh[1], 10);

  // GitLab: /merge_requests/123 or /-/merge_requests/123
  const gl = trimmed.match(/\/merge_requests\/(\d+)/);
  if (gl) return parseInt(gl[1], 10);

  // Bitbucket: /pull-requests/123
  const bb = trimmed.match(/\/pull-requests\/(\d+)/);
  if (bb) return parseInt(bb[1], 10);

  // Azure DevOps: /pullrequest/123
  const ado = trimmed.match(/\/pullrequest\/(\d+)/);
  if (ado) return parseInt(ado[1], 10);

  return null;
}

interface Props {
  prClient: PRClient;
  store: GraphStore;
  onGraphChange?: (focusNodeId?: string) => Promise<void>;
  /** LLM instance for running reviews. If absent, review button is hidden. */
  llm?: BaseChatModel | null;
  /** Switch to chat tab with a pre-seeded prompt */
  onChatWithPR?: (prompt: string) => void;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function PRListPanel({
  prClient,
  store,
  onGraphChange,
  llm,
  onChatWithPR,
}: Props) {
  const [prs, setPRs] = useState<PRSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPR, setSelectedPR] = useState<PRDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [indexingAll, setIndexingAll] = useState(false);
  const [lookupInput, setLookupInput] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    prClient
      .listPRs()
      .then((result) => {
        if (!cancelled) setPRs(result);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [prClient]);

  const handleSelectPR = async (pr: PRSummary) => {
    setLoadingDetail(true);
    try {
      const detail = await prClient.getPRDetail(pr.number);
      setSelectedPR(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleIndexPR = async (pr: PRDetail) => {
    await indexPRIntoGraph(store, pr, prClient.meta);
    await store.flush();
    const prId = `${prClient.meta.owner}/${prClient.meta.repo}/pr/${pr.number}`;
    await onGraphChange?.(prId);
  };

  const handleSelectInGraph = (pr: PRDetail) => {
    const prId = `${prClient.meta.owner}/${prClient.meta.repo}/pr/${pr.number}`;
    onGraphChange?.(prId);
  };

  const handleIndexAll = async () => {
    setIndexingAll(true);
    const errors: string[] = [];
    let lastPrId: string | undefined;
    for (const pr of prs) {
      try {
        const detail = await prClient.getPRDetail(pr.number);
        await indexPRIntoGraph(store, detail, prClient.meta);
        lastPrId = `${prClient.meta.owner}/${prClient.meta.repo}/pr/${pr.number}`;
      } catch (err) {
        errors.push(
          `PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (errors.length) {
      setError(`Failed to index ${errors.length} PR(s): ${errors.join('; ')}`);
    }
    await store.flush();
    await onGraphChange?.(lastPrId);
    setIndexingAll(false);
  };

  const handleLookup = async () => {
    const prNumber = parsePRInput(lookupInput);
    if (prNumber === null) {
      setLookupError('Enter a PR number (e.g. 123) or a link');
      return;
    }
    setLookupError(null);
    setLoadingDetail(true);
    try {
      const detail = await prClient.getPRDetail(prNumber);
      setSelectedPR(detail);
      setLookupInput('');
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  };

  if (selectedPR) {
    return (
      <PRDetailPanel
        pr={selectedPR}
        onBack={() => setSelectedPR(null)}
        onIndex={handleIndexPR}
        onSelectInGraph={handleSelectInGraph}
        llm={llm}
        store={store}
        prClient={prClient}
        onChatWithPR={onChatWithPR}
      />
    );
  }

  if (loading) {
    return (
      <div className="pr-list-panel">
        <div className="pr-list-loading">
          <OpenTraceLogo size={48} />
          <span>Loading pull requests...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pr-list-panel">
        <div className="pr-list-error">
          <span>Failed to load PRs: {error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-list-panel">
      <div className="pr-lookup-bar">
        <input
          className="pr-lookup-input"
          type="text"
          placeholder="Load PR by number or link..."
          value={lookupInput}
          onChange={(e) => {
            setLookupInput(e.target.value);
            setLookupError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
          disabled={loadingDetail}
        />
        <button
          className="pr-lookup-btn"
          onClick={handleLookup}
          disabled={loadingDetail || !lookupInput.trim()}
        >
          {loadingDetail ? 'Loading...' : 'Go'}
        </button>
      </div>
      {lookupError && <div className="pr-lookup-error">{lookupError}</div>}

      <div className="pr-list-header">
        <span className="pr-list-count">
          {prs.length} open {prs.length === 1 ? 'PR' : 'PRs'}
        </span>
        {prs.length > 0 && (
          <button
            className="pr-index-all-btn"
            onClick={handleIndexAll}
            disabled={indexingAll}
          >
            {indexingAll ? 'Indexing...' : 'Index All'}
          </button>
        )}
      </div>

      {loadingDetail && (
        <div className="pr-list-loading-bar">Loading PR details...</div>
      )}

      {prs.length === 0 ? (
        <div className="pr-list-empty">No open pull requests found.</div>
      ) : (
        <div className="pr-list-items">
          {prs.map((pr) => (
            <button
              key={pr.number}
              className="pr-list-item"
              onClick={() => handleSelectPR(pr)}
            >
              <div className="pr-item-top">
                <span className="pr-item-title">
                  <span className="pr-item-number">#{pr.number}</span>
                  {pr.title}
                </span>
                {pr.draft && <span className="pr-item-draft">Draft</span>}
              </div>
              <div className="pr-item-meta">
                <span className="pr-item-author">{pr.author}</span>
                <span className="pr-item-branch">{pr.head_branch}</span>
                <span className="pr-item-stats">
                  <span className="pr-stat-add">+{pr.additions}</span>
                  <span className="pr-stat-del">-{pr.deletions}</span>
                </span>
                <span className="pr-item-time">{timeAgo(pr.updated_at)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
