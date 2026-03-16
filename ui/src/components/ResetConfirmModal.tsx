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

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ResetConfirmModal({ onConfirm, onCancel }: Props) {
  return (
    <div
      className="modal-backdrop"
      onClick={onCancel}
      data-testid="reset-backdrop"
    >
      <div
        className="modal-card reset-confirm"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Reset OpenTrace?</h2>
        <p className="reset-confirm-text">
          This will reload the page and clear the current session.
        </p>
        <div className="reset-confirm-actions">
          <button
            type="button"
            className="btn-cta btn-cta--secondary"
            onClick={onCancel}
            data-testid="reset-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-cta btn-cta--destructive"
            onClick={onConfirm}
            data-testid="reset-confirm"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
