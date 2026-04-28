"""Shared helpers for OpenTrace Codex hooks.

The hooks live in ``~/.codex/hooks/`` (or ``<repo>/.codex/hooks/``) and are
invoked by Codex on SessionStart / UserPromptSubmit / PreToolUse events.
Each hook reads a JSON event from stdin and writes a JSON response to
stdout. Anything written to stderr is logged but ignored.

The hooks fail closed: if anything goes wrong (no DB, missing CLI,
subprocess error) we emit no output and let Codex proceed normally. They
should never block the model.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional


CACHE_DIR = Path(os.environ.get("TMPDIR", "/tmp")) / "opentrace-codex-hooks"
BRIEFING_CACHE_PATH = CACHE_DIR / "briefing.json"

BRIEFING_TTL_SECONDS = 600  # 10 minutes between auto-briefings
SUBPROCESS_TIMEOUT = 7
MAX_WALK_DEPTH = 10

SHELL_OPERATORS = ("|", "&&", "||", ";", "$(", "`")
SEARCH_COMMANDS = {"grep", "rg", "ack", "ag"}
READ_COMMANDS = {"cat", "head", "tail", "sed", "awk", "less", "more"}
SEARCH_VALUE_OPTIONS = {
    "-A", "-B", "-C", "-e", "-f", "-g", "-m", "-t",
    "--context", "--file", "--glob", "--max-count",
    "--regexp", "--type", "--type-add",
}
CODE_EXTENSIONS = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt",
    ".cs", ".c", ".cpp", ".h", ".hpp", ".rb", ".swift", ".proto",
    ".sql", ".graphql", ".gql", ".sh", ".bash",
})


# ---------------------------------------------------------------------------
# Event I/O
# ---------------------------------------------------------------------------

def read_event() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def emit_json(payload: dict) -> None:
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Workspace + DB discovery (mirrors agent/src/opentrace_agent/cli/main.py)
# ---------------------------------------------------------------------------

def find_workspace_root(start: Optional[str]) -> Optional[Path]:
    """Walk up from ``start`` looking for a `.opentrace/` directory or a git
    root. Returns the closest workspace root, or None.
    """
    if not start:
        start = os.getcwd()
    cur = Path(start).resolve()
    for _ in range(MAX_WALK_DEPTH):
        if (cur / ".opentrace").is_dir() or (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def find_db_path(workspace_root: Optional[Path]) -> Optional[Path]:
    if not workspace_root:
        return None
    db = workspace_root / ".opentrace" / "index.db"
    return db if db.is_file() else None


def opentrace_healthy(workspace_root: Optional[Path]) -> bool:
    return find_db_path(workspace_root) is not None


# ---------------------------------------------------------------------------
# CLI invocation
# ---------------------------------------------------------------------------

def run_opentraceai(args: list[str], cwd: Path, timeout: int = SUBPROCESS_TIMEOUT) -> Optional[str]:
    """Run the opentraceai CLI and return stripped stdout on success.

    Prefers a direct ``opentraceai`` binary; falls back to ``uvx opentraceai``
    when the binary is not on PATH. Returns None on any failure.
    """
    direct = shutil.which("opentraceai")
    cmd = [direct, *args] if direct else ["uvx", "opentraceai", *args]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(cwd),
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    out = result.stdout.strip()
    return out or None


# ---------------------------------------------------------------------------
# Shell command parsing
# ---------------------------------------------------------------------------

def _is_compound(command: str) -> bool:
    return any(op in command for op in SHELL_OPERATORS)


def extract_search_pattern(command: str) -> Optional[str]:
    """Parse a shell command and return a search pattern if it's an
    rg / grep / ack / ag invocation. Returns None for compound commands or
    when no plausible pattern is found.
    """
    if not command or _is_compound(command):
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens:
        return None
    base = os.path.basename(tokens[0])
    if base not in SEARCH_COMMANDS:
        return None

    skip_next = False
    for tok in tokens[1:]:
        if skip_next:
            skip_next = False
            continue
        if tok in SEARCH_VALUE_OPTIONS:
            skip_next = True
            continue
        if tok.startswith("-"):
            continue
        if len(tok) >= 3:
            return tok
    return None


def extract_read_path(command: str) -> Optional[str]:
    """Parse a shell command and return a file path if it's a
    cat / head / tail / sed / awk on a single code file.
    """
    if not command or _is_compound(command):
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens:
        return None
    base = os.path.basename(tokens[0])
    if base not in READ_COMMANDS:
        return None

    for tok in tokens[1:]:
        if tok.startswith("-"):
            continue
        # Accept anything that looks like a path with a code extension
        ext = os.path.splitext(tok)[1].lower()
        if ext in CODE_EXTENSIONS:
            return tok
    return None


# ---------------------------------------------------------------------------
# Message builders — call opentraceai and format the result
# ---------------------------------------------------------------------------

_SEARCH_NUDGE = (
    "Consider `keyword_search` or `find_usages` instead of shell search — "
    "the graph result above is already type-aware."
)
_READ_NUDGE = (
    "Consider `source_read` for the file body and `impact_analysis` for "
    "full blast-radius — they handle non-cwd repos too."
)


def build_search_message(pattern: str, workspace_root: Path) -> Optional[str]:
    """Run ``opentraceai augment`` for the pattern and wrap it as a Codex
    systemMessage. Returns None when the CLI returns nothing.

    ``opentraceai augment`` already emits its own ``[OpenTrace] Graph
    context for '<pattern>'`` header, so we append a routing nudge rather
    than re-wrapping.
    """
    out = run_opentraceai(["augment", "--", pattern], cwd=workspace_root)
    if not out:
        return None
    return f"{out}\n\n{_SEARCH_NUDGE}"


def build_read_message(file_path: str, workspace_root: Path) -> Optional[str]:
    """Run ``opentraceai impact`` on the file and wrap it as a systemMessage."""
    target = os.path.join(workspace_root, file_path) if not os.path.isabs(file_path) else file_path
    out = run_opentraceai(["impact", "--", target], cwd=workspace_root)
    if not out:
        return None
    return f"{out}\n\n{_READ_NUDGE}"


# ---------------------------------------------------------------------------
# Briefing TTL cache (UserPromptSubmit)
# ---------------------------------------------------------------------------

def briefing_due() -> bool:
    if not BRIEFING_CACHE_PATH.exists():
        return True
    try:
        data = json.loads(BRIEFING_CACHE_PATH.read_text())
        last = float(data.get("ts", 0))
    except (OSError, ValueError):
        return True
    return (time.time() - last) >= BRIEFING_TTL_SECONDS


def mark_briefing_sent() -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        BRIEFING_CACHE_PATH.write_text(json.dumps({"ts": time.time()}))
    except OSError:
        pass