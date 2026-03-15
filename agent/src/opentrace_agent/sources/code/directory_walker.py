"""Directory tree walker that builds a node hierarchy from a filesystem path."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

from opentrace_agent.models.base import NodeRelationship
from opentrace_agent.models.nodes import DirectoryNode, FileNode, RepoNode

logger = logging.getLogger(__name__)

EXCLUDED_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "vendor",
        "dist",
        "build",
        ".idea",
        ".vscode",
        ".mypy_cache",
        ".ruff_cache",
        ".pytest_cache",
        ".tox",
        ".eggs",
        "egg-info",
        ".claude",
    }
)

# File extensions we create FileNodes for
INCLUDED_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".py",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".go",
        ".rs",
        ".java",
        ".kt",
        ".rb",
        ".c",
        ".cpp",
        ".h",
        ".hpp",
        ".cs",
        ".swift",
        ".yaml",
        ".yml",
        ".json",
        ".toml",
        ".md",
        ".proto",
        ".graphql",
        ".sql",
        ".sh",
        ".bash",
        ".dockerfile",
        ".tf",
        ".hcl",
    }
)

EXTENSION_LANGUAGE_MAP: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".proto": "protobuf",
    ".graphql": "graphql",
    ".sql": "sql",
}


class DirectoryWalker:
    """Walks a directory tree and builds a RepoNode hierarchy."""

    def walk(
        self,
        root_path: Path,
        repo_id: str,
        repo_name: str,
        url: Optional[str] = None,
        default_branch: Optional[str] = None,
    ) -> RepoNode:
        """Walk *root_path* and return a ``RepoNode`` with directory/file children.

        Args:
            root_path: Absolute path to the cloned repository root.
            repo_id: Unique identifier for the repository (e.g. ``"owner/repo"``).
            repo_name: Human-readable repository name.
            url: Repository URL.
            default_branch: Branch that was cloned.

        Returns:
            A fully-built ``RepoNode`` tree.
        """
        repo_node = RepoNode(
            id=repo_id,
            name=repo_name,
            url=url,
            default_branch=default_branch,
        )

        # Map relative directory path → DirectoryNode for quick parent lookup
        dir_map: dict[str, DirectoryNode] = {}

        file_count = 0
        dir_count = 0

        for dirpath_str, dirnames, filenames in os.walk(root_path):
            # Filter excluded directories in-place so os.walk skips them
            dirnames[:] = [
                d
                for d in dirnames
                if d not in EXCLUDED_DIRS and not d.endswith(".egg-info")
            ]
            dirnames.sort()

            dirpath = Path(dirpath_str)
            rel_dir = dirpath.relative_to(root_path)
            rel_dir_str = str(rel_dir) if str(rel_dir) != "." else ""

            # Create or retrieve the DirectoryNode for this path
            if rel_dir_str == "":
                # Root level — children attach directly to repo_node
                parent_node = repo_node
            else:
                if rel_dir_str not in dir_map:
                    dir_node = DirectoryNode(
                        id=f"{repo_id}/{rel_dir_str}",
                        name=dirpath.name,
                        path=rel_dir_str,
                    )
                    dir_map[rel_dir_str] = dir_node
                    dir_count += 1

                    # Attach to parent
                    parent_rel = (
                        str(rel_dir.parent) if str(rel_dir.parent) != "." else ""
                    )
                    if parent_rel == "":
                        repo_node.add_child(
                            NodeRelationship(target=dir_node, relationship="DEFINED_IN")
                        )
                    else:
                        parent_dir = dir_map[parent_rel]
                        parent_dir.add_child(
                            NodeRelationship(target=dir_node, relationship="DEFINED_IN")
                        )

                parent_node = dir_map[rel_dir_str]

            # Process files
            for filename in sorted(filenames):
                ext = _get_extension(filename)
                if ext not in INCLUDED_EXTENSIONS:
                    continue

                rel_file = str(rel_dir / filename) if rel_dir_str else filename
                abs_file = str(dirpath / filename)

                file_node = FileNode(
                    id=f"{repo_id}/{rel_file}",
                    name=filename,
                    path=rel_file,
                    extension=ext,
                    language=EXTENSION_LANGUAGE_MAP.get(ext),
                    abs_path=abs_file,
                )
                parent_node.add_child(
                    NodeRelationship(target=file_node, relationship="DEFINED_IN")
                )
                file_count += 1

        logger.info(
            "Walked %s: %d directories, %d files",
            repo_id,
            dir_count,
            file_count,
        )
        return repo_node


def _get_extension(filename: str) -> str:
    """Return the lowercase file extension, handling special names."""
    lower = filename.lower()
    if lower == "dockerfile" or lower.startswith("dockerfile."):
        return ".dockerfile"
    _, ext = os.path.splitext(lower)
    return ext
