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

import { useRef, useState } from 'react';
import { PROVIDERS, PROVIDER_IDS, API_KEY_RESOURCES } from './providers';

interface Props {
  providerId: string;
  modelId: string;
  apiKey: string;
  localUrl: string;
  onProviderChange: (id: string) => void;
  onModelChange: (model: string) => void;
  onSave: (apiKey: string, localUrl?: string, model?: string) => void;
  onCancel?: () => void;
  canCancel: boolean;
}

export default function ChatSettings({
  providerId,
  modelId,
  apiKey,
  localUrl,
  onProviderChange,
  onModelChange,
  onSave,
  onCancel,
  canCancel,
}: Props) {
  const keyInputRef = useRef<HTMLInputElement>(null);
  const localUrlInputRef = useRef<HTMLInputElement>(null);
  const localModelInputRef = useRef<HTMLInputElement>(null);
  const [localModels, setLocalModels] = useState<string[] | null>(null);
  const [localModelsFetching, setLocalModelsFetching] = useState(false);

  const handleSaveKey = () => {
    const val = keyInputRef.current?.value.trim() ?? '';

    if (providerId === 'local') {
      const url = localUrlInputRef.current?.value.trim() ?? '';
      const model =
        localModels && localModels.length > 0
          ? modelId
          : (localModelInputRef.current?.value.trim() ?? modelId);
      onSave(val, url || undefined, model || undefined);
    } else {
      onSave(val);
    }
  };

  const fetchLocalModels = async () => {
    const url = localUrlInputRef.current?.value.trim() || localUrl;
    setLocalModelsFetching(true);
    setLocalModels(null);
    try {
      const res = await fetch(`${url}/v1/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const ids: string[] = (json.data ?? []).map((m: { id: string }) => m.id);
      setLocalModels(ids);
      if (ids.length > 0 && !ids.includes(modelId)) {
        onModelChange(ids[0]);
      }
    } catch {
      setLocalModels([]);
    } finally {
      setLocalModelsFetching(false);
    }
  };

  return (
    <div className="api-key-config">
      <div className="provider-selector">
        {PROVIDER_IDS.map((id) => (
          <button
            key={id}
            className={id === providerId ? 'active' : ''}
            onClick={() => onProviderChange(id)}
          >
            {PROVIDERS[id].name}
          </button>
        ))}
      </div>
      {providerId === 'local' ? (
        <>
          <div className="model-selector">
            <label htmlFor="local-url-input">URL</label>
            <input
              id="local-url-input"
              ref={localUrlInputRef}
              type="text"
              placeholder="http://localhost:11434"
              defaultValue={localUrl}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
              className="api-key-input"
            />
          </div>
          <div className="model-selector">
            <label htmlFor="local-model-input">Model</label>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'stretch' }}>
              {localModels && localModels.length > 0 ? (
                <select
                  id="local-model-input"
                  value={modelId}
                  onChange={(e) => onModelChange(e.target.value)}
                  className="api-key-input"
                  style={{ flex: 1, marginBottom: 0 }}
                >
                  {localModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="local-model-input"
                  ref={localModelInputRef}
                  type="text"
                  placeholder="llama3.2"
                  defaultValue={modelId}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
                  className="api-key-input"
                  style={{ flex: 1, marginBottom: 0 }}
                />
              )}
              <button
                className="settings-back-btn"
                onClick={fetchLocalModels}
                disabled={localModelsFetching}
                title="Fetch available models from the server"
                style={{ alignSelf: 'stretch' }}
              >
                {localModelsFetching ? '…' : 'Fetch'}
              </button>
            </div>
            {localModels !== null && localModels.length === 0 && (
              <p
                className="hint"
                style={{ color: 'var(--color-error, #f87171)' }}
              >
                Could not reach server or no models found.
              </p>
            )}
          </div>
          <p>API key (optional):</p>
          <input
            key={providerId}
            ref={keyInputRef}
            type="password"
            placeholder="Leave blank if not required"
            defaultValue={apiKey}
            onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
            className="api-key-input"
          />
        </>
      ) : (
        <>
          <div className="model-selector">
            <label htmlFor="model-select">Model</label>
            <select
              id="model-select"
              value={modelId}
              onChange={(e) => onModelChange(e.target.value)}
            >
              {PROVIDERS[providerId].models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <p>Enter your {PROVIDERS[providerId].name} API key:</p>
          <input
            key={providerId}
            ref={keyInputRef}
            type="password"
            placeholder="API Key..."
            defaultValue={apiKey}
            onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
            className="api-key-input"
          />
          {API_KEY_RESOURCES[providerId] && (
            <div className="api-key-help">
              <p className="api-key-help-title">
                How to get your {PROVIDERS[providerId].name} key:
              </p>
              <ol className="api-key-steps">
                <li>
                  Sign up at{' '}
                  <a
                    href={API_KEY_RESOURCES[providerId].signup}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {API_KEY_RESOURCES[providerId].signupLabel}
                  </a>
                </li>
                {API_KEY_RESOURCES[providerId].steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              <p className="api-key-help-footer">
                See the{' '}
                <a
                  href="https://opentrace.github.io/opentrace/reference/chat-providers/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  OpenTrace docs
                </a>{' '}
                or{' '}
                <a
                  href={API_KEY_RESOURCES[providerId].docs}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {PROVIDERS[providerId].name} docs
                </a>{' '}
                for more details.
              </p>
            </div>
          )}
        </>
      )}
      <div className="settings-actions">
        <button
          className="api-search-btn"
          style={{ flex: 1, padding: '8px' }}
          onClick={handleSaveKey}
        >
          Save
        </button>
        {canCancel && (
          <button
            className="settings-back-btn"
            style={{ padding: '8px' }}
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
      <p className="hint">Your key is stored locally in your browser.</p>
    </div>
  );
}
