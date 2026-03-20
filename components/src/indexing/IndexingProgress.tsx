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
 * IndexingProgress — overlay showing indexing status.
 *
 * Generic version: receives stage configuration as props instead of
 * relying on proto-generated JobPhase enum.
 */

import type {
  IndexingProgressProps,
  StageConfig,
  StageState,
} from './types';
import './indexing-base.css';
import './IndexingProgress.css';

// --- Provider small icons (for indexing header) ---

function GitHubIconSmall() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function GitLabIconSmall() {
  return (
    <svg width="20" height="20" viewBox="0 0 380 380" fill="currentColor">
      <path d="M190 353.9L131.1 172.8h117.8L190 353.9z" opacity="0.85" />
      <path d="M190 353.9L131.1 172.8H15.6L190 353.9z" opacity="0.7" />
      <path
        d="M15.6 172.8L0.4 219.5c-1.4 4.3 0.1 9 3.8 11.7L190 353.9 15.6 172.8z"
        opacity="0.55"
      />
      <path
        d="M15.6 172.8h115.5L87.6 26.5c-1.6-4.9-8.5-4.9-10.1 0L15.6 172.8z"
        opacity="0.85"
      />
      <path d="M190 353.9l58.9-181.1h115.5L190 353.9z" opacity="0.7" />
      <path
        d="M364.4 172.8l15.2 46.7c1.4 4.3-0.1 9-3.8 11.7L190 353.9l174.4-181.1z"
        opacity="0.55"
      />
      <path
        d="M364.4 172.8H248.9l43.5-146.3c1.6-4.9 8.5-4.9 10.1 0l61.9 146.3z"
        opacity="0.85"
      />
    </svg>
  );
}

// --- Multi-Stage Progress ---

/** Format a byte count as a human-readable MB string. */
function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function StageProgressRow({
  label,
  stage,
  removing,
}: {
  label: string;
  stage: StageState;
  removing?: boolean;
}) {
  const isCompleted = stage.status === 'completed';
  const isActive = stage.status === 'active';
  const indeterminate = isActive && stage.total === 0;
  const pct =
    stage.total > 0 ? Math.min(100, (stage.current / stage.total) * 100) : 0;
  const isBytes = stage.format === 'bytes';

  let cls = 'stage-row';
  if (removing) cls += ' stage-row--removing';
  else if (isCompleted) cls += ' stage-row--completed';
  else if (isActive) cls += ' stage-row--active';

  // Show completed message or active detail
  const detail = isCompleted
    ? stage.message
    : isActive && stage.message
      ? stage.message
      : '';

  return (
    <div className={cls}>
      <div className="stage-header">
        <span className="stage-label">{label}</span>
        <span className="stage-count">
          {stage.total > 0
            ? isBytes
              ? `${formatMB(stage.current)} / ${formatMB(stage.total)}`
              : `${stage.current}/${stage.total}`
            : stage.current > 0
              ? isBytes
                ? formatMB(stage.current)
                : `${stage.current}`
              : ''}
        </span>
      </div>
      {detail && <span className="stage-detail">{detail}</span>}
      <span
        className={`stage-bar${indeterminate ? ' stage-bar--indeterminate' : ''}`}
      >
        <span
          className="stage-bar-fill"
          style={
            indeterminate ? undefined : { width: `${isCompleted ? 100 : pct}%` }
          }
        />
      </span>
    </div>
  );
}

function MultiStageProgress({
  stages,
  stageConfig,
}: {
  stages: Record<string, StageState>;
  stageConfig: StageConfig[];
}) {
  // Build visible entries, filtering out stages that haven't started
  const entries = stageConfig
    .map(({ key, label }) => ({
      key,
      label,
      stage: stages[key],
    }))
    .filter((e): e is typeof e & { stage: StageState } => !!e.stage);

  // Find the last completed stage — all completed stages before it are "stale"
  let lastCompletedIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].stage.status === 'completed') {
      lastCompletedIdx = i;
      break;
    }
  }

  return (
    <div className="multi-stage-progress">
      {entries.map(({ key, label, stage }, i) => (
        <StageProgressRow
          key={key}
          label={label}
          stage={stage}
          removing={stage.status === 'completed' && i < lastCompletedIdx}
        />
      ))}
    </div>
  );
}

// --- Stats Grid ---

function StatsGrid({
  nodes,
  relationships,
}: {
  nodes: number;
  relationships: number;
}) {
  return (
    <div className="indexing-stats-grid">
      <div className="stat-card">
        <span className="stat-value">{nodes}</span>
        <span className="stat-label">Nodes</span>
      </div>
      <div className="stat-card">
        <span className="stat-value">{relationships}</span>
        <span className="stat-label">Edges</span>
      </div>
    </div>
  );
}

// --- Main Component ---

export default function IndexingProgress({
  state,
  stages: stageConfig,
  provider,
  onClose,
  onCancel,
  onMinimize,
  title,
  message,
}: IndexingProgressProps) {
  // --- Error ---
  if (state.status === 'error') {
    return (
      <div className="modal-backdrop">
        <div
          className="modal-card modal-card-wide"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="indexing-progress">
            <MultiStageProgress
              stages={state.stages}
              stageConfig={stageConfig}
            />

            <div className="failed-content">
              <div className="failed-icon">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <circle
                    cx="16"
                    cy="16"
                    r="14"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="color-mix(in oklch, currentColor 10%, transparent)"
                  />
                  <line
                    x1="11"
                    y1="11"
                    x2="21"
                    y2="21"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  <line
                    x1="21"
                    y1="11"
                    x2="11"
                    y2="21"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <h2>{title ?? 'Indexing Failed'}</h2>
              {state.error && <p className="failed-message">{state.error}</p>}
            </div>

            {(state.nodesCreated > 0 || state.relationshipsCreated > 0) && (
              <StatsGrid
                nodes={state.nodesCreated}
                relationships={state.relationshipsCreated}
              />
            )}

            <button className="btn-cta btn-cta--secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Done ---
  if (state.status === 'done') {
    return (
      <div className="modal-backdrop">
        <div
          className="modal-card modal-card-wide"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="indexing-progress">
            <MultiStageProgress
              stages={state.stages}
              stageConfig={stageConfig}
            />

            <div className="done-content">
              <div className="done-checkmark">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <circle
                    cx="16"
                    cy="16"
                    r="14"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="color-mix(in oklch, currentColor 15%, transparent)"
                  />
                  <polyline
                    className="done-check-path"
                    points="10,16.5 14,20.5 22,12"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
              </div>
              <h2>{title ?? 'Complete'}</h2>
            </div>

            <StatsGrid
              nodes={state.nodesCreated}
              relationships={state.relationshipsCreated}
            />

            {message && <p className="indexing-message">{message}</p>}

            <button
              className="btn-cta btn-cta--secondary"
              onClick={onMinimize ?? onClose}
            >
              {onMinimize ? 'Minimize' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Running ---
  return (
    <div className="modal-backdrop">
      <div
        className="modal-card modal-card-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="indexing-header">
          <span className="indexing-header-icon">
            {provider === 'gitlab' ? <GitLabIconSmall /> : <GitHubIconSmall />}
          </span>
          <h2>{title ?? 'Indexing Repository'}</h2>
        </div>
        <div className="indexing-progress">
          <MultiStageProgress
            stages={state.stages}
            stageConfig={stageConfig}
          />
          <StatsGrid
            nodes={state.nodesCreated}
            relationships={state.relationshipsCreated}
          />
          {message && <p className="indexing-message">{message}</p>}
          <button
            className="btn-cta btn-cta--secondary"
            onClick={onMinimize ?? onCancel}
          >
            {onMinimize ? 'Minimize' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
