"""Tests for opentrace_agent.sources.code.local_loader."""

from __future__ import annotations

from pathlib import Path

from opentrace_agent.sources.code.local_loader import LocalCodeLoader


class TestLocalCodeLoader:
    def test_load_basic(self, tmp_path: Path):
        """Index a small directory with Python files."""
        (tmp_path / "main.py").write_text("class App:\n    def run(self): pass\n")
        (tmp_path / "utils.py").write_text("def helper(): pass\n")

        loader = LocalCodeLoader()
        tree = loader.load(tmp_path)

        assert tree.origin == "code"
        assert tree.root.id == tmp_path.name
        assert tree.root.name == tmp_path.name
        assert tree.counters["repos"] == 1
        assert tree.counters["files"] >= 2
        assert tree.counters["classes"] >= 1  # App
        assert tree.counters["functions"] >= 2  # run, helper

    def test_load_custom_repo_id(self, tmp_path: Path):
        (tmp_path / "app.py").write_text("x = 1\n")

        loader = LocalCodeLoader()
        tree = loader.load(tmp_path, repo_id="my-org/my-repo")

        assert tree.root.id == "my-org/my-repo"

    def test_load_defaults_repo_id_to_dir_name(self, tmp_path: Path):
        (tmp_path / "app.py").write_text("x = 1\n")

        loader = LocalCodeLoader()
        tree = loader.load(tmp_path)

        assert tree.root.id == tmp_path.name

    def test_load_empty_directory(self, tmp_path: Path):
        """An empty directory should produce a tree with zero files."""
        loader = LocalCodeLoader()
        tree = loader.load(tmp_path)

        assert tree.counters["repos"] == 1
        assert tree.counters["files"] == 0
        assert tree.counters["classes"] == 0
        assert tree.counters["functions"] == 0

    def test_load_nested_directories(self, tmp_path: Path):
        """Nested directories should be walked recursively."""
        pkg = tmp_path / "src" / "pkg"
        pkg.mkdir(parents=True)
        (pkg / "mod.py").write_text("def greet(): pass\n")

        loader = LocalCodeLoader()
        tree = loader.load(tmp_path)

        assert tree.counters["files"] >= 1
        assert tree.counters["directories"] >= 2  # src, src/pkg
        assert tree.counters["functions"] >= 1

    def test_load_multiple_languages(self, tmp_path: Path):
        """Should handle Python, Go, and TypeScript files."""
        (tmp_path / "app.py").write_text("def py_func(): pass\n")
        (tmp_path / "main.go").write_text("package main\n\nfunc goFunc() {}\n")
        (tmp_path / "index.ts").write_text("function tsFunc(): void {}\n")

        loader = LocalCodeLoader()
        tree = loader.load(tmp_path)

        assert tree.counters["files"] >= 3
        assert tree.counters["functions"] >= 3
