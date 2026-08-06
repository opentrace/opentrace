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
 * CompileProgressPanel — bottom-left indicator for a background vault compile.
 *
 * Mirrors LiveIndexingPanel's language: a compact card with a progress bar and
 * a cancel affordance. Clicking the bar (or the header chevron) expands the
 * raw compile log — the stream the AddVaultModal used to show inline.
 */

import { useEffect, useState } from 'react';
import { useCompileJob } from '../providers/CompileJobProvider';
import './CompileProgressPanel.css';

interface Props {
  /** Lift the panel above the LiveIndexingPanel when both share the
   *  bottom-left corner (a server index job running alongside a compile). */
  raised?: boolean;
}

export default function CompileProgressPanel({ raised = false }: Props) {
  const { state, cancel, dismiss } = useCompileJob();
  const [expanded, setExpanded] = useState(false);

  // Auto-dismiss a settled compile so the card doesn't linger. Errors stay
  // sticky (the user needs to read them), and the timer pauses while the log
  // is expanded so inspecting the output doesn't yank it away.
  useEffect(() => {
    if (expanded) return;
    if (state.status !== 'done' && state.status !== 'cancelled') return;
    const t = setTimeout(dismiss, 4000);
    return () => clearTimeout(t);
  }, [state.status, expanded, dismiss]);

  if (state.status === 'idle') return null;

  const running = state.status === 'running';
  const determinate = running && state.total > 0;
  const pct = determinate
    ? Math.min(100, (state.current / state.total) * 100)
    : 0;

  const title =
    state.status === 'done'
      ? `Compiled ${state.vaultName}`
      : state.status === 'error'
        ? `Compile failed`
        : state.status === 'cancelled'
          ? `Compilation cancelled`
          : `Compiling ${state.vaultName}`;

  // While running, show the live phase (+ counts). Once settled, the phase
  // ("persisting") is stale and reads as still-in-progress — show the final
  // message instead ("Compiled", the error, "Compilation cancelled").
  const phaseLabel = running
    ? state.phase
      ? `${state.phase}${determinate ? ` · ${state.current}/${state.total}` : ''}`
      : state.message
    : state.message;

  return (
    <div
      className={`compile-panel${raised ? ' compile-panel--raised' : ''}`}
      data-testid="compile-progress-panel"
    >
      <div className="compile-panel__header">
        {running ? (
          <span className="compile-panel__spinner" aria-hidden />
        ) : (
          <span
            className={`compile-panel__glyph compile-panel__glyph--${state.status}`}
            aria-hidden
          >
            {state.status === 'done' ? '✓' : '✕'}
          </span>
        )}
        <span className="compile-panel__title" title={title}>
          {title}
        </span>
        <button
          type="button"
          className="compile-panel__btn"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Hide log' : 'Show log'}
          aria-label={expanded ? 'Hide compile log' : 'Show compile log'}
          aria-expanded={expanded}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
            style={{
              transform: expanded ? 'rotate(180deg)' : undefined,
              transition: 'transform 0.15s',
            }}
          >
            <path
              d="M3 5l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {running ? (
          <button
            type="button"
            className="compile-panel__btn compile-panel__btn--cancel"
            onClick={cancel}
            title="Cancel compilation"
            aria-label="Cancel compilation"
          >
            &times;
          </button>
        ) : (
          <button
            type="button"
            className="compile-panel__btn"
            onClick={dismiss}
            title="Dismiss"
            aria-label="Dismiss compile status"
          >
            &times;
          </button>
        )}
      </div>

      {/* Progress bar — click to toggle the log, per the "click the bar to see
          logs" affordance. */}
      <button
        type="button"
        className="compile-panel__bar-btn"
        onClick={() => setExpanded((v) => !v)}
        aria-label={expanded ? 'Hide compile log' : 'Show compile log'}
      >
        <span
          className={`compile-panel__bar${
            running && !determinate ? ' compile-panel__bar--indeterminate' : ''
          }`}
        >
          <span
            className={`compile-panel__fill compile-panel__fill--${state.status}`}
            style={
              running && !determinate
                ? undefined
                : {
                    width: `${state.status === 'done' ? 100 : running ? pct : 100}%`,
                  }
            }
          />
        </span>
      </button>

      <div className="compile-panel__phase">{phaseLabel}</div>

      {expanded && (
        <div className="compile-panel__log">
          {state.logs.length === 0 ? (
            <div className="compile-panel__log-empty">Waiting for output…</div>
          ) : (
            state.logs.map((line, i) => <div key={i}>{line}</div>)
          )}
          {state.error && (
            <div className="compile-panel__log-error">{state.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
