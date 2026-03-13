import { useCallback, useRef, useState } from 'react';
import {
  loadSummarizerStrategy,
  saveSummarizerStrategy,
  loadSummarizerLlmConfig,
  saveSummarizerLlmConfig,
} from '../config/summarization';
import type { SummarizationStrategyType } from '../runner/browser/enricher/summarizer/types';
import { useStore } from '../store';
import './SettingsDrawer.css';

const DEFAULT_MAX_NODES = 2000;
const DEFAULT_MAX_EDGES = 5000;
const LS_KEY_NODES = 'ot:maxVisNodes';
const LS_KEY_EDGES = 'ot:maxVisEdges';

function loadLimit(key: string, fallback: number): number {
  const v = localStorage.getItem(key);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface SettingsDrawerProps {
  onClose: () => void;
  onGraphCleared: () => void;
  onLimitsChanged?: () => void;
}

export default function SettingsDrawer({
  onClose,
  onGraphCleared,
  onLimitsChanged,
}: SettingsDrawerProps) {
  const { store } = useStore();
  const [clearing, setClearing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryStrategy, setSummaryStrategy] =
    useState<SummarizationStrategyType>(loadSummarizerStrategy);
  const [llmConfig, setLlmConfig] = useState(loadSummarizerLlmConfig);
  const [llmModels, setLlmModels] = useState<string[] | null>(null);
  const [llmModelsFetching, setLlmModelsFetching] = useState(false);
  const [maxNodes, setMaxNodes] = useState(() =>
    loadLimit(LS_KEY_NODES, DEFAULT_MAX_NODES),
  );
  const [maxEdges, setMaxEdges] = useState(() =>
    loadLimit(LS_KEY_EDGES, DEFAULT_MAX_EDGES),
  );

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

  const handleLlmConfigChange = (url: string, model: string) => {
    setLlmConfig({ url, model });
    saveSummarizerLlmConfig(url, model);
  };

  const fetchLlmModels = async () => {
    setLlmModelsFetching(true);
    setLlmModels(null);
    try {
      const res = await fetch(`${llmConfig.url}/v1/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const ids: string[] = (json.data ?? []).map((m: { id: string }) => m.id);
      setLlmModels(ids);
      if (ids.length > 0 && !ids.includes(llmConfig.model)) {
        handleLlmConfigChange(llmConfig.url, ids[0]);
      }
    } catch {
      setLlmModels([]);
    } finally {
      setLlmModelsFetching(false);
    }
  };

  const limitsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const debouncedLimitsChanged = useCallback(() => {
    clearTimeout(limitsTimer.current);
    limitsTimer.current = setTimeout(() => onLimitsChanged?.(), 400);
  }, [onLimitsChanged]);

  const applyLimits = async (nodes: number, edges: number) => {
    localStorage.setItem(LS_KEY_NODES, String(nodes));
    localStorage.setItem(LS_KEY_EDGES, String(edges));
    await store.setLimits?.(nodes, edges);
    debouncedLimitsChanged();
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
                className={`toggle-btn${summaryStrategy === 'llm' ? ' active' : ''}`}
                onClick={() => handleStrategyChange('llm')}
              >
                Local LLM
              </button>
              <button
                type="button"
                className={`toggle-btn${summaryStrategy === 'none' ? ' active' : ''}`}
                onClick={() => handleStrategyChange('none')}
              >
                Disabled
              </button>
            </div>
            {summaryStrategy === 'llm' && (
              <div className="llm-summarizer-config" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="limit-row">
                  <label className="limit-label" htmlFor="sum-llm-url">URL</label>
                  <input
                    id="sum-llm-url"
                    type="text"
                    className="settings-select"
                    value={llmConfig.url}
                    onChange={(e) =>
                      handleLlmConfigChange(e.target.value, llmConfig.model)
                    }
                  />
                </div>
                <div className="limit-row">
                  <label className="limit-label" htmlFor="sum-llm-model">Model</label>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'stretch', flex: 1 }}>
                    {llmModels && llmModels.length > 0 ? (
                      <select
                        id="sum-llm-model"
                        className="settings-select"
                        value={llmConfig.model}
                        onChange={(e) =>
                          handleLlmConfigChange(llmConfig.url, e.target.value)
                        }
                      >
                        {llmModels.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id="sum-llm-model"
                        type="text"
                        className="settings-select"
                        value={llmConfig.model}
                        onChange={(e) =>
                          handleLlmConfigChange(llmConfig.url, e.target.value)
                        }
                      />
                    )}
                    <button
                      className="settings-back-btn"
                      onClick={fetchLlmModels}
                      disabled={llmModelsFetching}
                      title="Fetch available models from the server"
                      style={{ alignSelf: 'stretch' }}
                    >
                      {llmModelsFetching ? '…' : 'Fetch'}
                    </button>
                  </div>
                  {llmModels !== null && llmModels.length === 0 && (
                    <p className="setting-hint" style={{ color: 'var(--color-error, #f87171)', margin: 0 }}>
                      Could not reach server or no models found.
                    </p>
                  )}
                </div>
              </div>
            )}
            <p className="setting-hint">
              {summaryStrategy === 'template'
                ? 'Instant summaries from code naming conventions. No model download.'
                : summaryStrategy === 'ml'
                  ? 'Higher quality for complex code. Downloads ~77MB model on first run.'
                  : summaryStrategy === 'llm'
                    ? 'Uses a local LLM (e.g. Ollama) via its OpenAI-compatible API.'
                    : 'Nodes indexed without summaries.'}
            </p>
          </div>
        </section>

        <section className="settings-section">
          <h4>Graph Limits</h4>
          <div className="setting-card">
            <div className="setting-info">
              <strong>Visualization limits</strong>
              <p>
                Maximum nodes and edges rendered in the graph view. Higher
                values let you visualize larger graphs but may slow down the
                force layout.
              </p>
            </div>
            <div className="limit-row">
              <label className="limit-label" htmlFor="max-nodes">
                Max nodes
              </label>
              <input
                id="max-nodes"
                type="number"
                className="limit-input"
                min={100}
                max={50000}
                step={500}
                value={maxNodes}
                onChange={(e) => {
                  const v = Math.max(
                    100,
                    Number(e.target.value) || DEFAULT_MAX_NODES,
                  );
                  setMaxNodes(v);
                  applyLimits(v, maxEdges);
                }}
              />
            </div>
            <div className="limit-row">
              <label className="limit-label" htmlFor="max-edges">
                Max edges
              </label>
              <input
                id="max-edges"
                type="number"
                className="limit-input"
                min={100}
                max={100000}
                step={1000}
                value={maxEdges}
                onChange={(e) => {
                  const v = Math.max(
                    100,
                    Number(e.target.value) || DEFAULT_MAX_EDGES,
                  );
                  setMaxEdges(v);
                  applyLimits(maxNodes, v);
                }}
              />
            </div>
            <p className="setting-hint">
              Defaults: {DEFAULT_MAX_NODES.toLocaleString()} nodes /{' '}
              {DEFAULT_MAX_EDGES.toLocaleString()} edges.
            </p>
          </div>
        </section>

        <section className="settings-section danger-zone">
          <h4>Danger Zone</h4>
          <div className="danger-card">
            <div className="danger-info">
              <strong>Clear graph database</strong>
              <p>
                Remove all nodes and edges from KuzuDB. This action cannot be
                undone.
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
