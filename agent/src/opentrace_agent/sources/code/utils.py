"""Shared utilities for code source loaders."""

from __future__ import annotations

from collections import deque
from typing import Any

from opentrace_agent.models.nodes import DirectoryNode, FileNode


def count_nodes(root: Any) -> tuple[int, int]:
    """Count directory and file nodes in a tree via BFS.

    Returns:
        A tuple of (directory_count, file_count).
    """
    dirs = 0
    files = 0
    visited: set[str] = set()
    queue: deque[Any] = deque([root])
    while queue:
        node = queue.popleft()
        if node.id in visited:
            continue
        visited.add(node.id)
        if isinstance(node, DirectoryNode):
            dirs += 1
        elif isinstance(node, FileNode):
            files += 1
        for rel in node.children:
            queue.append(rel.target)
    return dirs, files
