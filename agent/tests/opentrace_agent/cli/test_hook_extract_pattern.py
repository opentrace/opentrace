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

"""Tests for pattern extraction logic in the hook script.

We import from the hook script directly via importlib since it's not a package.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

# Import the hook module from the plugin scripts directory
_HOOK_PATH = Path(__file__).resolve().parents[4] / "claude-code-plugin" / "scripts" / "opentrace-hook.py"
_spec = importlib.util.spec_from_file_location("opentrace_hook", _HOOK_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
extract_pattern = _mod.extract_pattern


# -- Grep --------------------------------------------------------------------


def test_grep_returns_pattern():
    assert extract_pattern("Grep", {"pattern": "KuzuStore"}) == "KuzuStore"


def test_grep_empty():
    assert extract_pattern("Grep", {}) is None


# -- Glob --------------------------------------------------------------------


def test_glob_extracts_identifier():
    assert extract_pattern("Glob", {"pattern": "**/*.tsx"}) == "tsx"


def test_glob_extracts_longer_identifier():
    assert extract_pattern("Glob", {"pattern": "src/components/GraphViewer.*"}) == "src"


def test_glob_no_identifier():
    assert extract_pattern("Glob", {"pattern": "**/*"}) is None


def test_glob_underscore_prefix():
    assert extract_pattern("Glob", {"pattern": "_augment.py"}) == "_augment"


# -- Bash (rg/grep) ----------------------------------------------------------


def test_bash_rg_simple():
    assert extract_pattern("Bash", {"command": "rg KuzuStore"}) == "KuzuStore"


def test_bash_grep_simple():
    assert extract_pattern("Bash", {"command": "grep handleRequest src/"}) == "handleRequest"


def test_bash_rg_with_flags():
    assert extract_pattern("Bash", {"command": "rg -i --type py KuzuStore"}) == "KuzuStore"


def test_bash_rg_skips_flag_values():
    assert extract_pattern("Bash", {"command": "rg -A 3 -B 2 --glob '*.py' pattern_here"}) == "pattern_here"


def test_bash_rg_short_tokens_skipped():
    assert extract_pattern("Bash", {"command": "rg ab longpattern"}) == "longpattern"


def test_bash_ignores_non_search_commands():
    assert extract_pattern("Bash", {"command": "ls -la"}) is None


def test_bash_ignores_git():
    assert extract_pattern("Bash", {"command": "git status"}) is None


def test_bash_empty_command():
    assert extract_pattern("Bash", {"command": ""}) is None


def test_bash_no_command_key():
    assert extract_pattern("Bash", {}) is None


# -- Unknown tool ------------------------------------------------------------


def test_unknown_tool():
    assert extract_pattern("Read", {"file_path": "/some/file"}) is None
