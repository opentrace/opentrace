#!/usr/bin/env bash
# OpenTrace Codex hooks — installer wrapper.
#
# Wraps scripts/install_codex_integration.py with a friendlier CLI.
# Hooks are independent of the Codex plugin marketplace; install them
# once globally (--home) or per-repo (--repo /path/to/project).
#
# Usage:
#   ./install.sh --home
#   ./install.sh --home --mode symlink
#   ./install.sh --repo /path/to/project
#   ./install.sh --home --force      # overwrite existing hook files
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/scripts/install_codex_integration.py"

usage() {
  cat <<'EOF'
OpenTrace Codex hooks installer

Usage:
  ./install.sh --home [--mode copy|symlink] [--force]
  ./install.sh --repo /path/to/project [--mode copy|symlink] [--force]

Options:
  --home              Install into ~/.codex (recommended for most users)
  --repo <path>       Install into <path>/.codex (per-repo only)
  --mode copy         Copy files into place (default)
  --mode symlink      Symlink files (faster local-dev iteration)
  --force             Overwrite conflicting destination files
  -h, --help          Show this message and exit

Notes:
  - Hooks complement the Codex marketplace plugin — install both.
  - The plugin alone gives you skills + MCP. The hooks add session-start
    guidance, periodic graph briefings, and shell rg/grep augmentation.
  - This script never modifies your config.toml plugin/marketplace
    stanzas; it only enables the codex_hooks feature flag.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "error: python3 (or python) is required to run the installer" >&2
  exit 1
fi

exec "$PYTHON_BIN" "$INSTALLER" "$@"