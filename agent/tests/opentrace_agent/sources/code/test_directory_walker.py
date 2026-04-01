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

"""Tests for opentrace_agent.sources.code.directory_walker."""

from __future__ import annotations

from pathlib import Path

from opentrace_agent.sources.code.directory_walker import DirectoryWalker


class TestDirectoryWalker:
    def _make_tree(self, tmp_path: Path) -> None:
        """Create a small directory tree for testing."""
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "main.py").write_text("print('hello')")
        (tmp_path / "src" / "utils.py").write_text("def helper(): pass")
        (tmp_path / "src" / "sub").mkdir()
        (tmp_path / "src" / "sub" / "module.ts").write_text("export function foo() {}")
        (tmp_path / "README.md").write_text("# Hello")
        # Excluded dirs
        (tmp_path / "node_modules").mkdir()
        (tmp_path / "node_modules" / "dep.js").write_text("nope")
        (tmp_path / ".git").mkdir()
        (tmp_path / ".git" / "config").write_text("nope")
        # Non-included extension
        (tmp_path / "image.png").write_bytes(b"\x89PNG")

    def test_walk_basic_structure(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo", url="https://github.com/org/repo")

        repo_nodes = [n for n in result.nodes if n.type == "Repository"]
        assert len(repo_nodes) == 1
        assert repo_nodes[0].id == "org/repo"
        assert repo_nodes[0].name == "repo"

    def test_walk_creates_directories(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo")

        dir_names = {n.name for n in result.nodes if n.type == "Directory"}
        assert "src" in dir_names
        assert "sub" in dir_names

    def test_walk_excludes_dirs(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo")

        all_names = {n.name for n in result.nodes}
        assert "node_modules" not in all_names
        assert ".git" not in all_names
        assert "dep.js" not in all_names

    def test_walk_excludes_non_included_extensions(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo")

        all_names = {n.name for n in result.nodes}
        assert "image.png" not in all_names

    def test_walk_file_nodes_have_correct_attributes(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo")

        file_nodes = [n for n in result.nodes if n.type == "File"]
        main_py = next(n for n in file_nodes if n.name == "main.py")
        assert main_py.id == "org/repo/src/main.py"
        assert main_py.properties["path"] == "src/main.py"
        assert main_py.properties["extension"] == ".py"
        assert main_py.properties["language"] == "python"

    def test_walk_nested_directory_ids(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo")

        dir_nodes = [n for n in result.nodes if n.type == "Directory"]
        sub_dir = next(d for d in dir_nodes if d.name == "sub")
        assert sub_dir.id == "org/repo/src/sub"
        assert sub_dir.properties["path"] == "src/sub"

    def test_walk_empty_directory(self, tmp_path: Path):
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/empty", "empty")
        # Only the Repository node
        assert len(result.nodes) == 1
        assert result.nodes[0].type == "Repository"
        assert len(result.relationships) == 0

    def test_walk_typescript_file(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo")

        file_nodes = [n for n in result.nodes if n.type == "File"]
        ts_file = next(n for n in file_nodes if n.name == "module.ts")
        assert ts_file.properties["extension"] == ".ts"
        assert ts_file.properties["language"] == "typescript"

    def test_walk_defines_relationships(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo")

        # repo → src dir
        src_rel = next(r for r in result.relationships if r.target_id == "org/repo/src" and r.type == "DEFINES")
        assert src_rel.source_id == "org/repo"

        # src dir → main.py
        main_rel = next(
            r for r in result.relationships if r.target_id == "org/repo/src/main.py" and r.type == "DEFINES"
        )
        assert main_rel.source_id == "org/repo/src"

    def test_walk_file_entries(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo")

        parseable_paths = {fe.path for fe in result.file_entries}
        assert "src/main.py" in parseable_paths
        assert "src/utils.py" in parseable_paths
        assert "src/sub/module.ts" in parseable_paths

    def test_walk_path_to_file_id(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        result = walker.walk(tmp_path, "org/repo", "repo")

        assert result.path_to_file_id["src/main.py"] == "org/repo/src/main.py"
