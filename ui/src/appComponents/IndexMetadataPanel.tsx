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
import type { IndexMetadata } from '../store/types';
import { useStore } from '../store/context';
import './IndexMetadataPanel.css';

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Coerce a value to a primitive string — handles boxed String/Number objects from LadybugDB WASM. */
function s(v: unknown): string {
  return v != null ? String(v) : '';
}

function MetadataEntry({ meta }: { meta: IndexMetadata }) {
  const sha = s(meta.commitSha);
  const branch = s(meta.branch);
  const commitRef = sha
    ? branch
      ? `${branch}@${sha.slice(0, 8)}`
      : sha.slice(0, 8)
    : branch || null;

  return (
    <div className="index-metadata-entry">
      {meta.repoId && (
        <div className="index-metadata-row">
          <span className="index-metadata-label">Repo</span>
          <span
            className="index-metadata-value index-metadata-mono"
            title={s(meta.sourceUri || meta.repoPath || meta.repoId)}
          >
            {s(meta.repoId)}
          </span>
        </div>
      )}
      {meta.indexedAt && (
        <div className="index-metadata-row">
          <span className="index-metadata-label">Indexed</span>
          <span className="index-metadata-value">
            {formatDate(s(meta.indexedAt))}
          </span>
        </div>
      )}
      {commitRef && (
        <div className="index-metadata-row">
          <span className="index-metadata-label">Ref</span>
          <span className="index-metadata-value index-metadata-mono">
            {commitRef}
          </span>
        </div>
      )}
      {meta.commitMessage && (
        <div className="index-metadata-row">
          <span className="index-metadata-label">Commit</span>
          <span className="index-metadata-value" title={s(meta.commitMessage)}>
            {s(meta.commitMessage)}
          </span>
        </div>
      )}
      {meta.durationSeconds != null && (
        <div className="index-metadata-row">
          <span className="index-metadata-label">Duration</span>
          <span className="index-metadata-value">
            {s(meta.durationSeconds)}s
          </span>
        </div>
      )}
    </div>
  );
}

interface Props {
  graphVersion?: number;
}

export default function IndexMetadataPanel({ graphVersion }: Props) {
  const { store } = useStore();
  const [entries, setEntries] = useState<IndexMetadata[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    store.fetchMetadata().then((result) => {
      if (!cancelled) setEntries(result);
    });
    return () => {
      cancelled = true;
    };
  }, [store, graphVersion]);

  if (entries.length === 0) return null;

  return (
    <div className="index-metadata">
      <div className="index-metadata-header">
        <button
          className="filter-section-collapse-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            className={`filter-expand-icon ${collapsed ? '' : 'filter-expand-icon--open'}`}
          >
            <path
              d="M3 2 L7 5 L3 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </button>
        <span
          className="filter-section-title"
          onClick={() => setCollapsed((c) => !c)}
        >
          Index Info
        </span>
      </div>
      {!collapsed && (
        <div className="index-metadata-entries">
          {entries.map((meta, i) => (
            <MetadataEntry key={meta.repoId ?? i} meta={meta} />
          ))}
        </div>
      )}
    </div>
  );
}
