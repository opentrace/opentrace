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

"""Test harness for the OpenTrace Claude Code plugin.

Provides fixtures that isolate every test from the user's real state:
- ``tmp_cache`` redirects ``$TMPDIR`` so the per-UID cache directory
  (briefing.json, context.json, staleness.json, last_index.json) lives
  under pytest's tmp tree instead of the user's machine.
- ``tmp_workspace`` builds a synthetic workspace with a fake
  ``.opentrace/index.db`` so workspace discovery succeeds without a
  real index.

Both fixtures force a re-import of ``_common`` after the env mutation so
module-level constants (``CACHE_DIR``, ``BRIEFING_CACHE_PATH``, etc.)
pick up the new ``$TMPDIR``.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

# Make the hook scripts importable as bare module names ("_common",
# "post_tool_use", etc.) — matches how hooks.json invokes them.
PLUGIN_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _reload_common():
    """Re-import _common after $TMPDIR changes so CACHE_DIR is rebound."""
    if "_common" in sys.modules:
        return importlib.reload(sys.modules["_common"])
    return importlib.import_module("_common")


@pytest.fixture
def tmp_cache(tmp_path, monkeypatch):
    """Redirect the hook cache directory into pytest's tmp tree."""
    tmpdir = tmp_path / "tmpdir"
    tmpdir.mkdir()
    monkeypatch.setenv("TMPDIR", str(tmpdir))
    # Ensure no stale debug env from the developer's shell leaks in.
    monkeypatch.delenv("OPENTRACE_DEBUG", raising=False)
    monkeypatch.delenv("OPENTRACE_DEBUG_LOG", raising=False)
    monkeypatch.delenv("OPENTRACE_CLAUDE_AUTO_CONTEXT", raising=False)
    monkeypatch.delenv("OPENTRACE_CLAUDE_AUGMENT_BASH", raising=False)
    return _reload_common()


@pytest.fixture
def tmp_workspace(tmp_path):
    """Build a synthetic workspace with ``.opentrace/index.db`` present."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".git").mkdir()
    opentrace_dir = workspace / ".opentrace"
    opentrace_dir.mkdir()
    db = opentrace_dir / "index.db"
    db.write_text("synthetic-db")
    return workspace


@pytest.fixture
def fake_run_opentraceai(monkeypatch):
    """Replace ``run_opentraceai`` in any module the test imports.

    Returns a controller with ``set(output)`` / ``calls`` so tests can
    inject stdout for stats/impact/augment without spawning a subprocess.
    """
    state = {"output": None, "calls": []}

    def _fake(args, cwd, timeout=None):
        state["calls"].append({"args": list(args), "cwd": str(cwd)})
        return state["output"]

    class _Ctl:
        def set(self, output):
            state["output"] = output

        @property
        def calls(self):
            return state["calls"]

    # Patch every module that holds its own reference to run_opentraceai.
    for mod_name in (
        "_common",
        "session_start",
        "pre_compact",
        "notification",
        "post_tool_use",
    ):
        if mod_name in sys.modules:
            try:
                monkeypatch.setattr(sys.modules[mod_name], "run_opentraceai", _fake)
            except AttributeError:
                pass
    return _Ctl()