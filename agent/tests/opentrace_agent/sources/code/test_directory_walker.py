"""Tests for opentrace_agent.sources.code.directory_walker."""

from __future__ import annotations

from pathlib import Path

from opentrace_agent.models.nodes import DirectoryNode, FileNode, RepoNode
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
        repo = walker.walk(
            tmp_path, "org/repo", "repo", url="https://github.com/org/repo"
        )

        assert isinstance(repo, RepoNode)
        assert repo.id == "org/repo"
        assert repo.name == "repo"
        assert repo.url == "https://github.com/org/repo"

    def test_walk_creates_directories(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        repo = walker.walk(tmp_path, "org/repo", "repo")

        # Root should have src dir and README.md directly
        child_names = {rel.target.name for rel in repo.children}
        assert "src" in child_names
        assert "README.md" in child_names

    def test_walk_excludes_dirs(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        repo = walker.walk(tmp_path, "org/repo", "repo")

        all_names = _collect_names(repo)
        assert "node_modules" not in all_names
        assert ".git" not in all_names
        assert "dep.js" not in all_names

    def test_walk_excludes_non_included_extensions(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        repo = walker.walk(tmp_path, "org/repo", "repo")

        all_names = _collect_names(repo)
        assert "image.png" not in all_names

    def test_walk_file_nodes_have_correct_attributes(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        repo = walker.walk(tmp_path, "org/repo", "repo")

        files = _collect_files(repo)
        main_py = next(f for f in files if f.name == "main.py")
        assert main_py.id == "org/repo/src/main.py"
        assert main_py.path == "src/main.py"
        assert main_py.extension == ".py"
        assert main_py.language == "python"
        assert main_py.abs_path == str(tmp_path / "src" / "main.py")

    def test_walk_nested_directory_ids(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        repo = walker.walk(tmp_path, "org/repo", "repo")

        dirs = _collect_dirs(repo)
        sub_dir = next(d for d in dirs if d.name == "sub")
        assert sub_dir.id == "org/repo/src/sub"
        assert sub_dir.path == "src/sub"

    def test_walk_empty_directory(self, tmp_path: Path):
        walker = DirectoryWalker()
        repo = walker.walk(tmp_path, "org/empty", "empty")
        assert repo.id == "org/empty"
        assert len(repo.children) == 0

    def test_walk_typescript_file(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        repo = walker.walk(tmp_path, "org/repo", "repo")

        files = _collect_files(repo)
        ts_file = next(f for f in files if f.name == "module.ts")
        assert ts_file.extension == ".ts"
        assert ts_file.language == "typescript"

    def test_walk_parent_references(self, tmp_path: Path):
        self._make_tree(tmp_path)
        walker = DirectoryWalker()
        repo = walker.walk(tmp_path, "org/repo", "repo")

        files = _collect_files(repo)
        main_py = next(f for f in files if f.name == "main.py")
        # Parent should be the src DirectoryNode
        assert main_py.parent is not None
        assert isinstance(main_py.parent, DirectoryNode)
        assert main_py.parent.name == "src"


def _collect_names(node: RepoNode) -> set[str]:
    """Collect all node names in the tree."""
    names = {node.name}
    for rel in node.children:
        names.add(rel.target.name)
        if hasattr(rel.target, "children"):
            names.update(_collect_names_inner(rel.target))
    return names


def _collect_names_inner(node) -> set[str]:
    names = set()
    for rel in node.children:
        names.add(rel.target.name)
        if hasattr(rel.target, "children"):
            names.update(_collect_names_inner(rel.target))
    return names


def _collect_files(node) -> list[FileNode]:
    """Collect all FileNodes in the tree."""
    files = []
    for rel in node.children:
        if isinstance(rel.target, FileNode):
            files.append(rel.target)
        else:
            files.extend(_collect_files(rel.target))
    return files


def _collect_dirs(node) -> list[DirectoryNode]:
    """Collect all DirectoryNodes in the tree."""
    dirs = []
    for rel in node.children:
        if isinstance(rel.target, DirectoryNode):
            dirs.append(rel.target)
            dirs.extend(_collect_dirs(rel.target))
    return dirs
