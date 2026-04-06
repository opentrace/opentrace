# OpenTrace konductor environment setup
# Usage: source .konductor/envrc.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Node.js (via nvm) ────────────────────────────
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    if [ -f "$REPO_ROOT/.nvmrc" ]; then
        nvm use
    else
        nvm use default
    fi
else
    echo "warn: nvm not found at $NVM_DIR" >&2
fi

# ── Python (venv) ────────────────────────────────
VENV_DIR="$REPO_ROOT/agent/.venv"
if [ -d "$VENV_DIR" ]; then
    . "$VENV_DIR/bin/activate"
else
    echo "warn: Python venv not found at $VENV_DIR" >&2
    echo "      run: cd $REPO_ROOT/agent && uv sync" >&2
fi
