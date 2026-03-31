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

import { useState } from 'react';

interface Props {
  onExport: (options: { includeSource: boolean }) => void;
  onCancel: () => void;
}

export default function ExportModal({ onExport, onCancel }: Props) {
  const [includeSource, setIncludeSource] = useState(false);

  return (
    <div
      className="modal-backdrop"
      onClick={onCancel}
      data-testid="export-backdrop"
    >
      <div
        className="modal-card export-options"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Export Database</h2>
        <p className="export-options-text">
          Export the graph as a Parquet archive.
        </p>
        <label className="export-options-checkbox">
          <input
            type="checkbox"
            checked={includeSource}
            onChange={(e) => setIncludeSource(e.target.checked)}
            data-testid="export-include-source"
          />
          <span>
            Include source text{' '}
            <span className="export-options-hint">
              (enables full-text search on import, increases file size)
            </span>
          </span>
        </label>
        <div className="export-options-actions">
          <button
            type="button"
            className="btn-cta btn-cta--secondary"
            onClick={onCancel}
            data-testid="export-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-cta"
            onClick={() => onExport({ includeSource })}
            data-testid="export-confirm"
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
