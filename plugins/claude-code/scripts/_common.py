# Copyright 2026 OpenTrace Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Shared helpers for the OpenTrace Claude Code plugin hooks.

The hooks live in ``${CLAUDE_PLUGIN_ROOT}/scripts/`` and are invoked by
Claude Code on SessionStart / UserPromptSubmit / PreToolUse / PostToolUse
events. Each hook reads a JSON event from stdin and writes a JSON
response to stdout. Anything written to stderr is logged but ignored.

The hooks fail closed: on any error (no DB, missing CLI, subprocess
error) we emit no output and let Claude Code proceed normally. They
should never block the model.
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Briefing TTL cache — UserPromptSubmit re-injects routing guidance every
# BRIEFING_TTL_SECONDS so the model doesn't drift back to shell tools.
# Per-UID directory so multi-user systems don't collide.
# ---------------------------------------------------------------------------

_UID = getattr(os, "getuid", lambda: "shared")()
CACHE_DIR = Path(os.environ.get("TMPDIR", "/tmp")) / f"opentrace-claude-hooks-{_UID}"
BRIEFING_CACHE_PATH = CACHE_DIR / "briefing.json"

BRIEFING_TTL_SECONDS = 600  # 10 minutes between auto-briefings
SUBPROCESS_TIMEOUT = 7
MAX_WALK_DEPTH = 10

# Shell parsing — used by PreToolUse to decide whether a Bash command is
# something we should augment with graph context.
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
    """Read and parse the JSON event Claude Code writes to our stdin."""
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


def emit_hook_output(event: str, context: str) -> None:
    """Emit a hookSpecificOutput envelope with additionalContext."""
    emit_json({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": context,
        }
    })


# ---------------------------------------------------------------------------
# Workspace + DB discovery (mirrors agent/src/opentrace_agent/cli/main.py)
# ---------------------------------------------------------------------------

def find_workspace_root(start: Optional[str]) -> Optional[Path]:
    """Walk up from ``start`` looking for a `.opentrace/` directory or git
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

def run_opentraceai(
    args: list[str],
    cwd: Path | str,
    timeout: int = SUBPROCESS_TIMEOUT,
) -> Optional[str]:
    """Run the opentraceai CLI and return stripped stdout on success.

    Prefers a direct ``opentraceai`` binary; falls back to ``uvx
    opentraceai`` when the binary is not on PATH. Returns None on any
    failure.
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


# Operator tokens that shlex.split surfaces as standalone tokens when the
# input contains them unquoted. Used to slice a token list into stages.
_STAGE_BREAK_TOKENS = frozenset({"|", "||", "&&", ";"})


def _split_stages(command: str) -> list[list[str]]:
    """Split a shell command into stages by top-level operators
    (``|``, ``||``, ``&&``, ``;``).

    Quoted operators are preserved as part of their token because
    ``shlex.split`` honors quoting. Returns one token list per stage,
    or an empty list when the input can't be parsed.
    """
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return []
    stages: list[list[str]] = []
    current: list[str] = []
    for tok in tokens:
        if tok in _STAGE_BREAK_TOKENS:
            if current:
                stages.append(current)
                current = []
        else:
            current.append(tok)
    if current:
        stages.append(current)
    return stages


def _pattern_from_search_tokens(tokens: list[str]) -> Optional[str]:
    """Extract the search pattern from a single rg/grep/ack/ag stage."""
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


def _path_from_read_tokens(tokens: list[str]) -> Optional[str]:
    """Extract the code file path from a single cat/head/tail/sed/awk stage."""
    if not tokens:
        return None
    base = os.path.basename(tokens[0])
    if base not in READ_COMMANDS:
        return None
    for tok in tokens[1:]:
        if tok.startswith("-"):
            continue
        ext = os.path.splitext(tok)[1].lower()
        if ext in CODE_EXTENSIONS:
            return tok
    return None


def extract_search_pattern(command: str) -> Optional[str]:
    """Return the search pattern of the first rg/grep/ack/ag stage in
    *command*. Handles pipelines and ``&&`` / ``||`` / ``;`` chains so
    real-world commands like ``grep foo | head`` still get augmented.
    """
    if not command:
        return None
    for stage in _split_stages(command):
        pat = _pattern_from_search_tokens(stage)
        if pat:
            return pat
    return None


def extract_read_path(command: str) -> Optional[str]:
    """Return the file path of the first cat/head/tail/sed/awk stage on
    a code file. Handles pipelines and chains the same way as
    ``extract_search_pattern``.
    """
    if not command:
        return None
    for stage in _split_stages(command):
        path = _path_from_read_tokens(stage)
        if path:
            return path
    return None


def is_code_file(path: str) -> bool:
    """Check if the file extension suggests indexable source code."""
    _, ext = os.path.splitext(path)
    return ext.lower() in CODE_EXTENSIONS


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
    """Run ``opentraceai augment`` for the pattern and wrap it as a
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
    """Run ``opentraceai impact`` on the file and wrap as a systemMessage."""
    target = (
        file_path
        if os.path.isabs(file_path)
        else os.path.join(str(workspace_root), file_path)
    )
    out = run_opentraceai(["impact", "--", target], cwd=workspace_root)
    if not out:
        return None
    return f"{out}\n\n{_READ_NUDGE}"


def estimate_line_range(new_string: str, file_path: str) -> Optional[str]:
    """Try to figure out which lines were affected by an Edit.

    Reads the post-edit file and finds where new_string lands; pads the
    range slightly to catch the surrounding function/class.
    Returns a line spec like "10-25" or None if undeterminable.
    """
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except OSError:
        return None

    idx = content.find(new_string)
    if idx == -1:
        return None

    start_line = content[:idx].count("\n") + 1
    end_line = start_line + new_string.count("\n")
    start_line = max(1, start_line - 5)
    end_line = end_line + 5
    return f"{start_line}-{end_line}"


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
