import { useState } from 'react';
import {
  loadSummarizerStrategy,
  saveSummarizerStrategy,
} from '../config/summarization';
import type { SummarizationStrategyType } from '../runner/browser/enricher/summarizer/types';
import { useStore } from '../store';
import './SettingsDrawer.css';

interface SettingsDrawerProps {
  onClose: () => void;
  onGraphCleared: () => void;
}

export default function SettingsDrawer({
  onClose,
  onGraphCleared,
}: SettingsDrawerProps) {
  const { store } = useStore();
  const [clearing, setClearing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryStrategy, setSummaryStrategy] =
    useState<SummarizationStrategyType>(loadSummarizerStrategy);

  const handleClear = async () => {
    setClearing(true);
    setError(null);
    try {
      await store.clearGraph();
      setConfirmOpen(false);
      onGraphCleared();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear graph');
    } finally {
      setClearing(false);
    }
  };

  const handleStrategyChange = (strategy: SummarizationStrategyType) => {
    setSummaryStrategy(strategy);
    saveSummarizerStrategy(strategy);
  };

  return (
    <div className="settings-drawer">
      <div className="panel-header">
        <h3>Settings</h3>
        <button className="close-btn" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="settings-content">
        <section className="settings-section">
          <h4>Indexing</h4>
          <div className="setting-card">
            <div className="setting-info">
              <strong>Summarization</strong>
              <p>How node summaries are generated during indexing.</p>
            </div>
            <div className="toggle-group">
              <button
                type="button"
                className={`toggle-btn${summaryStrategy === 'template' ? ' active' : ''}`}
                onClick={() => handleStrategyChange('template')}
              >
                Template (Fast)
              </button>
              <button
                type="button"
                className={`toggle-btn${summaryStrategy === 'ml' ? ' active' : ''}`}
                onClick={() => handleStrategyChange('ml')}
              >
                ML Model
              </button>
              <button
                type="button"
                className={`toggle-btn${summaryStrategy === 'none' ? ' active' : ''}`}
                onClick={() => handleStrategyChange('none')}
              >
                Disabled
              </button>
            </div>
            <p className="setting-hint">
              {summaryStrategy === 'template'
                ? 'Instant summaries from code naming conventions. No model download.'
                : summaryStrategy === 'ml'
                  ? 'Higher quality for complex code. Downloads ~77MB model on first run.'
                  : 'Nodes indexed without summaries.'}
            </p>
          </div>
        </section>

        <section className="settings-section danger-zone">
          <h4>Danger Zone</h4>
          <div className="danger-card">
            <div className="danger-info">
              <strong>Clear graph database</strong>
              <p>
                Remove all nodes and relationships from KuzuDB. This action
                cannot be undone.
              </p>
            </div>
            {!confirmOpen ? (
              <button
                className="danger-btn"
                onClick={() => setConfirmOpen(true)}
              >
                Clear Database
              </button>
            ) : (
              <div className="confirm-actions">
                <span className="confirm-label">Are you sure?</span>
                <button
                  className="danger-btn confirm"
                  onClick={handleClear}
                  disabled={clearing}
                >
                  {clearing ? 'Clearing...' : 'Yes, clear everything'}
                </button>
                <button
                  className="cancel-btn"
                  onClick={() => setConfirmOpen(false)}
                  disabled={clearing}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          {error && <p className="danger-error">{error}</p>}
        </section>
      </div>
    </div>
  );
}
