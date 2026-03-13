import { JobPhase } from '../job';
import type { JobState } from '../job';
import './JobMinimizedBar.css';

const PHASE_LABELS: Partial<Record<JobPhase, string>> = {
  [JobPhase.JOB_PHASE_ENRICHING]: 'Enriching',
  [JobPhase.JOB_PHASE_SUBMITTING]: 'Submitting',
};

interface Props {
  state: JobState;
  onClick: () => void;
  onCancel: () => void;
}

export default function JobMinimizedBar({ state, onClick, onCancel }: Props) {
  const isDone = state.status === 'done';
  const label = isDone
    ? 'Complete'
    : (PHASE_LABELS[state.phase] ?? 'Enriching');
  const hasCount = !isDone && state.detail.total > 0;

  return (
    <div
      className={`job-minimized-bar${isDone ? ' job-minimized-bar--done' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      {...(isDone ? { 'data-testid': 'indexing-complete' } : {})}
    >
      {isDone ? (
        <span className="job-minimized-bar__check">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <polyline
              points="3,7.5 5.5,10 11,4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : (
        <div className="job-minimized-bar__spinner" />
      )}
      <span className="job-minimized-bar__phase">{label}</span>
      <span className="job-minimized-bar__count">
        {hasCount ? `${state.detail.current}/${state.detail.total}` : ''}
      </span>
      <span className="job-minimized-bar__nodes">
        {state.nodesCreated} nodes
      </span>
      {!isDone && (
        <button
          className="job-minimized-bar__cancel"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          title="Cancel enrichment"
        >
          &times;
        </button>
      )}
    </div>
  );
}
