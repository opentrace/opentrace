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
  icon,
  onClose,
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

            <button className="btn-cta btn-cta--secondary" onClick={onClose}>
              Close
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
          {icon && <span className="indexing-header-icon">{icon}</span>}
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
        </div>
      </div>
    </div>
  );
}
