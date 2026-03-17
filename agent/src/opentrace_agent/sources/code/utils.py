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
