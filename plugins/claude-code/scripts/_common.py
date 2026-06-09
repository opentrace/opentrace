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

import hashlib
import json
import os
import shlex
import shutil
import stat
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
CONTEXT_CACHE_PATH = CACHE_DIR / "context.json"
# Per-workspace edited-file tracker; keys are sha256 of (workspace_root|path)
# so multi-repo sessions don't collide. Values are {path, mtime, ts}.
STALENESS_CACHE_PATH = CACHE_DIR / "staleness.json"
# Sentinel for "the indexer wrote a new index.db since the last Notification";
# stores the workspace_root → db_mtime that we last announced.
LAST_INDEX_CACHE_PATH = CACHE_DIR / "last_index.json"

def _ensure_cache_dir() -> None:
    """Create ``CACHE_DIR`` private to the current user, failing closed if it
    looks tampered with.

    The cache may live under a world-writable temp root (e.g. ``/tmp`` on
    Linux), so a local attacker could pre-create the directory — or symlinks
    inside it — and redirect our ``write_text`` calls onto a victim's files
    (``~/.ssh/authorized_keys`` and the like). Defenses:

    * create with mode ``0o700`` so no other user can drop files/symlinks in;
    * if it already exists, refuse (raise ``OSError``) when it is a symlink or
      owned by another user.

    Callers wrap this in ``try/except OSError`` and skip the write on failure,
    so a hijacked directory degrades to "no cache" rather than a clobbered
    file. A 0700 directory we own can't hold another user's symlinks, which
    neutralizes the file-level attack too.
    """
    CACHE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = CACHE_DIR.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise OSError(f"cache dir is not a regular directory: {CACHE_DIR}")
    getuid = getattr(os, "getuid", None)
    if getuid is not None and info.st_uid != getuid():
        raise OSError(f"cache dir not owned by current user: {CACHE_DIR}")
    # Tighten perms in case it pre-existed (or umask loosened the create).
    os.chmod(CACHE_DIR, 0o700)


BRIEFING_TTL_SECONDS = 600  # 10 minutes between auto-briefings
CONTEXT_TTL_SECONDS = 300  # 5 minutes between duplicate hook payloads
STALENESS_MAX_AGE_SECONDS = 7 * 24 * 3600  # prune entries older than 7 days
MAX_ADDITIONAL_CONTEXT_CHARS = 6000
AUTO_CONTEXT_DEFAULT = False
BASH_AUGMENT_DEFAULT = False
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


def env_flag_enabled(name: str, default: bool = True) -> bool:
    """Parse a boolean environment flag for hook feature gates."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def cap_context(context: str, max_chars: int = MAX_ADDITIONAL_CONTEXT_CHARS) -> str:
    """Cap hook-injected context so repeated tool use cannot flood prompts."""
    if len(context) <= max_chars:
        return context
    omitted = len(context) - max_chars
    suffix = f"\n\n[OpenTrace] Context truncated; {omitted} chars omitted."
    if len(suffix) >= max_chars:
        return suffix[:max_chars]
    return context[: max(0, max_chars - len(suffix))].rstrip() + suffix


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
        _ensure_cache_dir()
        BRIEFING_CACHE_PATH.write_text(json.dumps({"ts": time.time()}))
    except OSError:
        pass


def context_cache_key(workspace_root: Path, event: str, kind: str, value: str) -> str:
    """Stable cache key for duplicate hook context suppression."""
    raw = f"{workspace_root.resolve()}|{event}|{kind}|{value}"
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()


def context_recently_emitted(key: str, ttl: int = CONTEXT_TTL_SECONDS) -> bool:
    try:
        data = json.loads(CONTEXT_CACHE_PATH.read_text())
    except (OSError, ValueError):
        return False
    last = data.get(key)
    try:
        return (time.time() - float(last)) < ttl
    except (TypeError, ValueError):
        return False


def mark_context_emitted(key: str) -> None:
    try:
        data = json.loads(CONTEXT_CACHE_PATH.read_text())
    except (OSError, ValueError):
        data = {}

    now = time.time()
    cutoff = now - (CONTEXT_TTL_SECONDS * 2)
    compact = {}
    for existing_key, ts in data.items():
        try:
            if float(ts) >= cutoff:
                compact[existing_key] = ts
        except (TypeError, ValueError):
            continue
    compact[key] = now

    try:
        _ensure_cache_dir()
        CONTEXT_CACHE_PATH.write_text(json.dumps(compact))
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Staleness tracker — PostToolUse writes, UserPromptSubmit/Stop/statusline read.
# Records every Edit/Write so a later prompt can warn when the graph is stale
# vs. the on-disk source.
# ---------------------------------------------------------------------------

def _load_staleness() -> dict:
    try:
        return json.loads(STALENESS_CACHE_PATH.read_text())
    except (OSError, ValueError):
        return {}


def _save_staleness(data: dict) -> None:
    try:
        _ensure_cache_dir()
        STALENESS_CACHE_PATH.write_text(json.dumps(data))
    except OSError:
        pass


def record_edit(file_path: str, workspace_root: Optional[Path]) -> None:
    """Persist an edited file's path + current mtime. Per-workspace keyed.

    Called from PostToolUse on every Edit/Write — runs unconditionally
    (no env gate) since storage cost is trivial and downstream readers
    do the staleness comparison.
    """
    if not workspace_root or not file_path:
        return
    try:
        mtime = os.path.getmtime(file_path)
    except OSError:
        return
    key = context_cache_key(workspace_root, "Staleness", "edit", file_path)
    data = _load_staleness()
    data[key] = {
        "path": file_path,
        "mtime": mtime,
        "ts": time.time(),
        "workspace": str(workspace_root.resolve()),
    }
    _save_staleness(data)


def stale_files(workspace_root: Path) -> list[str]:
    """Return edited file paths in this workspace whose mtime exceeds
    the index DB's mtime. Empty list when the index is fresh.
    """
    db = find_db_path(workspace_root)
    if not db:
        return []
    try:
        db_mtime = db.stat().st_mtime
    except OSError:
        return []
    workspace_str = str(workspace_root.resolve())
    data = _load_staleness()
    stale: list[str] = []
    for entry in data.values():
        if not isinstance(entry, dict):
            continue
        if entry.get("workspace") != workspace_str:
            continue
        try:
            mtime = float(entry.get("mtime", 0))
        except (TypeError, ValueError):
            continue
        path = entry.get("path")
        if path and mtime > db_mtime and os.path.exists(path):
            stale.append(path)
    stale.sort()
    return stale


def prune_staleness(max_age_seconds: int = STALENESS_MAX_AGE_SECONDS) -> None:
    """Drop staleness entries older than ``max_age_seconds``. Called from Stop."""
    data = _load_staleness()
    if not data:
        return
    cutoff = time.time() - max_age_seconds
    kept = {}
    for key, entry in data.items():
        if not isinstance(entry, dict):
            continue
        try:
            ts = float(entry.get("ts", 0))
        except (TypeError, ValueError):
            continue
        if ts >= cutoff:
            kept[key] = entry
    if len(kept) != len(data):
        _save_staleness(kept)


# ---------------------------------------------------------------------------
# Last-index sentinel — SessionStart records the DB mtime it injected;
# Notification compares against the current mtime and announces when a
# background index has completed since then.
# ---------------------------------------------------------------------------

def _load_last_index() -> dict:
    try:
        return json.loads(LAST_INDEX_CACHE_PATH.read_text())
    except (OSError, ValueError):
        return {}


def record_index_complete(workspace_root: Path, db_mtime: float) -> None:
    """Note that we've already announced ``db_mtime`` to the user for this
    workspace. Subsequent Notification fires only announce newer DBs.
    """
    data = _load_last_index()
    data[str(workspace_root.resolve())] = db_mtime
    try:
        _ensure_cache_dir()
        LAST_INDEX_CACHE_PATH.write_text(json.dumps(data))
    except OSError:
        pass


def last_index_seen(workspace_root: Path) -> Optional[float]:
    data = _load_last_index()
    val = data.get(str(workspace_root.resolve()))
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Directive builder — used by SessionStart and PreCompact so both events
# produce identical routing guidance.
# ---------------------------------------------------------------------------

_BASE_DIRECTIVE = (
    "OpenTrace is active. The codebase is indexed into a knowledge graph.\n"
    "Prefer the `opentrace-*` skills and MCP tools (`keyword_search`, "
    "`find_usages`, `traverse_graph`, `source_read`, `source_grep`, "
    "`impact_analysis`) over shell `rg` / `grep` / `find` / `cat`.\n"
    "Fall back to shell only when the graph returns nothing or the file "
    "isn't in any indexed repo."
)


def build_directive(stats: Optional[str] = None, db_path: Optional[Path] = None) -> str:
    """Return the routing directive plus optional stats/db lines.

    SessionStart and PreCompact both call this so the post-compact context
    window receives the same routing guidance the session started with.
    """
    lines = [_BASE_DIRECTIVE]
    if stats:
        lines.extend(["", "Current graph state:", stats])
    if db_path:
        lines.extend(["", f"Index: {db_path}"])
    return "\n".join(lines)
