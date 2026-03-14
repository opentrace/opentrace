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
