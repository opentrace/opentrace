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

"""Tests for the OT-1732 Phase 6 Grep retrieval primitive."""

from __future__ import annotations

import os
import shutil
import subprocess
import time

import pytest

ladybug = pytest.importorskip("real_ladybug")


def _find_rg() -> str | None:
    """Locate ripgrep on PATH or in well-known vendored locations.

    Tests run inside ``uv run`` which sometimes strips PATH entries,
    so we widen the search to include the few places ``rg`` is bundled
    on developer machines (Claude Code vendors one for the IDE).
    """
    p = shutil.which("rg")
    if p:
        return p
    for candidate in (
        "/usr/bin/rg",
        "/usr/local/bin/rg",
        os.path.expanduser(
            "~/.nvm/versions/node/v18.20.6/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-linux/rg"
        ),
    ):
        if os.access(candidate, os.X_OK):
            return candidate
    return None


_RG = _find_rg()
if _RG is None:
    pytest.skip("ripgrep ('rg') not available", allow_module_level=True)

# Ensure the retrieval module's `shutil.which("rg")` finds the same binary
# we're about to test against.
os.environ["PATH"] = os.path.dirname(_RG) + os.pathsep + os.environ.get("PATH", "")

from opentrace_agent.retrieval import grep  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    s = GraphStore(str(tmp_path / "grepdb"))
    yield s
    s.close()


@pytest.fixture()
def fixture_repo(tmp_path):
    """Create a small on-disk repo with grep-able content."""
    root = tmp_path / "myrepo"
    (root / "src").mkdir(parents=True)
    (root / "src" / "main.py").write_text(
        "def greet():\n    return 'hello world'\n\ndef shout():\n    return 'HELLO WORLD'\n"
    )
    (root / "src" / "db.py").write_text("def connect():\n    return 'db connection'\n")
    (root / "README.md").write_text("# myrepo\n\nA tiny fixture.\n")
    return root


# ---------------------------------------------------------------------------
# Repository scope
# ---------------------------------------------------------------------------


class TestGrepRepositoryScope:
    def test_basic_match(self, store, fixture_repo):
        store.add_node(
            "myorg/myrepo",
            "Repository",
            "myrepo",
            {"local_path": str(fixture_repo)},
        )
        result = grep(store, "hello", scope_id="myorg/myrepo")
        assert result["mode"] == "ripgrep"
        assert result["count"] >= 2  # 'hello' and 'HELLO' both match (case-insensitive)
        files = {m["file_path"] for m in result["matches"]}
        assert "src/main.py" in files

    def test_case_sensitive(self, store, fixture_repo):
        store.add_node(
            "myorg/myrepo",
            "Repository",
            "myrepo",
            {"local_path": str(fixture_repo)},
        )
        result = grep(store, "HELLO", scope_id="myorg/myrepo", case_sensitive=True)
        # Only the upper-case match
        assert all("HELLO" in m["line_text"] for m in result["matches"])
        # Should NOT include the lowercase 'hello world'
        assert all("hello world" not in m["line_text"] for m in result["matches"])

    def test_file_filter(self, store, fixture_repo):
        store.add_node(
            "myorg/myrepo",
            "Repository",
            "myrepo",
            {"local_path": str(fixture_repo)},
        )
        result = grep(store, "def", scope_id="myorg/myrepo", file_filter="db")
        # Only db.py should be searched.
        files = {m["file_path"] for m in result["matches"]}
        assert files == {"src/db.py"}

    def test_resolves_node_id(self, store, fixture_repo):
        store.add_node(
            "myorg/myrepo",
            "Repository",
            "myrepo",
            {"local_path": str(fixture_repo)},
        )
        result = grep(store, "greet", scope_id="myorg/myrepo")
        assert result["count"] >= 1
        m = result["matches"][0]
        assert m["node_id"] == "myorg/myrepo/src/main.py"

    def test_missing_local_path(self, store):
        store.add_node("myorg/cloned", "Repository", "cloned", {"sourceUri": "https://..."})
        result = grep(store, "x", scope_id="myorg/cloned")
        assert result["mode"] == "error"
        assert "local_path" in result["error"]

    def test_path_gone_from_disk(self, store, tmp_path):
        ghost = str(tmp_path / "deleted")
        store.add_node("myorg/ghost", "Repository", "ghost", {"local_path": ghost})
        result = grep(store, "x", scope_id="myorg/ghost")
        assert result["mode"] == "error"
        assert "not a directory" in result["error"]

    def test_unknown_scope_node(self, store):
        result = grep(store, "x", scope_id="missing")
        assert result["mode"] == "error"

    def test_unsupported_scope_type(self, store):
        store.add_node("f1", "File", "main.py", {"path": "src/main.py"})
        result = grep(store, "x", scope_id="f1")
        assert result["mode"] == "error"
        assert "unsupported scope type" in result["error"]

    def test_max_results_cap(self, store, tmp_path):
        # Generate a file with many matches.
        root = tmp_path / "big"
        root.mkdir()
        (root / "many.txt").write_text("\n".join("foo" for _ in range(200)))
        store.add_node("myorg/big", "Repository", "big", {"local_path": str(root)})
        result = grep(store, "foo", scope_id="myorg/big", max_results=10)
        assert result["count"] <= 10


# ---------------------------------------------------------------------------
# Performance — within 2x native ripgrep on a fixture repo
# ---------------------------------------------------------------------------


class TestGrepPerformance:
    """OT-1732 success criterion: grep within 2x of native ripgrep."""

    def test_within_2x_of_native_rg(self, store, tmp_path):
        # Build a repo of ~200 files with mixed content.
        root = tmp_path / "perfrepo"
        for i in range(20):
            d = root / f"pkg{i}"
            d.mkdir(parents=True)
            for j in range(10):
                (d / f"mod{j}.py").write_text("\n".join(f"def fn_{i}_{j}_{k}():\n    return {k}" for k in range(20)))
        store.add_node("perf/repo", "Repository", "repo", {"local_path": str(root)})

        # Native ripgrep timing.
        t0 = time.monotonic()
        subprocess.run(
            ["rg", "--ignore-case", "fn_5", str(root)],
            capture_output=True,
            check=False,
        )
        native_elapsed = time.monotonic() - t0

        # Our wrapper timing.
        t0 = time.monotonic()
        result = grep(store, "fn_5", scope_id="perf/repo", max_results=5000)
        wrapper_elapsed = time.monotonic() - t0

        assert result["count"] > 0
        # Allow generous slack on small fixtures where overhead dominates;
        # wall-time floor at 50ms keeps the ratio meaningful.
        floor = max(native_elapsed, 0.05)
        assert wrapper_elapsed <= floor * 2.0, (
            f"grep wrapper too slow: {wrapper_elapsed * 1000:.0f}ms vs "
            f"native rg {native_elapsed * 1000:.0f}ms (2x ratio: {floor * 2 * 1000:.0f}ms)"
        )
