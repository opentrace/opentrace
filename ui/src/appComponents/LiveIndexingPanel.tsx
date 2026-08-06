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
 * LiveIndexingPanel — compact bottom-left indexing indicator.
 *
 * Replaces the full-screen IndexingProgress modal as the *default* surface
 * while a browser index job runs. The graph builds live behind it; this panel
 * just reports phase, per-stage progress, and running node/edge counts, with
 * an "expand" affordance to open the full modal on demand.
 */

import type { ReactNode } from 'react';
import type { JobState, StageState } from '../job';
import './LiveIndexingPanel.css';

interface StageDef {
  key: string;
  label: string;
}

interface Props {
  state: JobState;
  /** Ordered stage definitions (same list the full modal uses). */
  stages: StageDef[];
  /** Provider logo, shown in the header. */
  icon?: ReactNode;
  /** Open the full-detail indexing modal. */
  onExpand: () => void;
  /** Collapse the panel to a compact chip — indexing keeps running. */
  onMinimize: () => void;
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function StageRow({ label, stage }: { label: string; stage: StageState }) {
  const isCompleted = stage.status === 'completed';
  const isActive = stage.status === 'active';
  const indeterminate = isActive && stage.total === 0;
  const pct =
    stage.total > 0 ? Math.min(100, (stage.current / stage.total) * 100) : 0;
  const isBytes = stage.format === 'bytes';

  let count = '';
  if (stage.total > 0) {
    count = isBytes
      ? `${formatMB(stage.current)} / ${formatMB(stage.total)}`
      : `${stage.current}/${stage.total}`;
  } else if (stage.current > 0) {
    count = isBytes ? formatMB(stage.current) : `${stage.current}`;
  }

  return (
    <div
      className={`live-stage${isActive ? ' live-stage--active' : ''}${
        isCompleted ? ' live-stage--completed' : ''
      }`}
    >
      <div className="live-stage__head">
        <span className="live-stage__dot" aria-hidden>
          {isCompleted ? '✓' : ''}
        </span>
        <span className="live-stage__label">{label}</span>
        <span className="live-stage__count">{count}</span>
      </div>
      <span
        className={`live-stage__bar${
          indeterminate ? ' live-stage__bar--indeterminate' : ''
        }`}
      >
        <span
          className="live-stage__fill"
          style={
            indeterminate ? undefined : { width: `${isCompleted ? 100 : pct}%` }
          }
        />
      </span>
    </div>
  );
}

export default function LiveIndexingPanel({
  state,
  stages,
  icon,
  onExpand,
  onMinimize,
}: Props) {
  // Only stages that have started — keeps the panel short early on.
  const rows = stages
    .map(({ key, label }) => ({
      key,
      label,
      stage: (state.stages as Record<string, StageState>)[key],
    }))
    .filter((e): e is typeof e & { stage: StageState } => !!e.stage);

  const headLabel =
    state.status === 'enriching'
      ? 'Enriching graph'
      : state.status === 'persisted'
        ? 'Building graph'
        : 'Indexing';

  return (
    <div className="live-indexing-panel" data-testid="live-indexing-panel">
      <div className="live-indexing-panel__header">
        <span className="live-indexing-panel__spinner" aria-hidden />
        {icon && <span className="live-indexing-panel__icon">{icon}</span>}
        <span className="live-indexing-panel__title">{headLabel}</span>
        <button
          type="button"
          className="live-indexing-panel__btn"
          onClick={onExpand}
          title="Show full details"
          aria-label="Expand indexing details"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path
              d="M2 5V2h3M12 9v3H9M9 2h3v3M5 12H2V9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="live-indexing-panel__btn"
          onClick={onMinimize}
          title="Minimize — indexing continues in the background"
          aria-label="Minimize indexing panel"
        >
          &minus;
        </button>
      </div>

      {rows.length > 0 && (
        <div className="live-indexing-panel__stages">
          {rows.map(({ key, label, stage }) => (
            <StageRow key={key} label={label} stage={stage} />
          ))}
        </div>
      )}

      <div className="live-indexing-panel__stats">
        <span>
          <strong>{state.nodesCreated.toLocaleString()}</strong> nodes
        </span>
        <span className="live-indexing-panel__dot-sep" aria-hidden>
          ·
        </span>
        <span>
          <strong>{state.relationshipsCreated.toLocaleString()}</strong> edges
        </span>
      </div>
    </div>
  );
}
