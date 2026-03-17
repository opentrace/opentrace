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

"""Tests for opentrace_agent.graph.mapper."""

from __future__ import annotations

import pytest

from opentrace_agent.graph.mapper import GraphMapper, MappingResult
from opentrace_agent.models.base import NodeRelationship, TreeWithOrigin
from opentrace_agent.models.nodes import DirectoryNode, FileNode, RepoNode


def _make_simple_tree() -> TreeWithOrigin:
    """Create a repo -> dir -> file tree."""
    repo = RepoNode(id="org/repo", name="repo", url="https://github.com/org/repo")
    dir_node = DirectoryNode(id="org/repo/src", name="src", path="src")
    file_node = FileNode(id="org/repo/src/main.py", name="main.py", path="src/main.py")

    repo.add_child(NodeRelationship(target=dir_node, relationship="DEFINED_IN"))
    dir_node.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

    return TreeWithOrigin(root=repo, origin="code")


class TestGraphMapper:
    @pytest.mark.anyio
    async def test_map_trees_counts(self, mock_mcp):
        mapper = GraphMapper(mock_mcp)
        tree = _make_simple_tree()

        result = await mapper.map_trees([tree])

        assert result.nodes_created == 3
        assert result.relationships_created == 2
        assert result.errors == []

    @pytest.mark.anyio
    async def test_map_empty_trees(self, mock_mcp):
        mapper = GraphMapper(mock_mcp)
        result = await mapper.map_trees([])

        assert result.nodes_created == 0
        assert result.relationships_created == 0

    @pytest.mark.anyio
    async def test_handles_mcp_tool_error(self, error_mcp):
        mapper = GraphMapper(error_mcp)
        tree = _make_simple_tree()

        result = await mapper.map_trees([tree])

        assert result.nodes_created == 0
        assert result.relationships_created == 0
        assert len(result.errors) > 0

    @pytest.mark.anyio
    async def test_no_duplicate_visits(self, mock_mcp):
        mapper = GraphMapper(mock_mcp)

        repo = RepoNode(id="r", name="repo")
        file1 = FileNode(id="f1", name="a.py")
        file2 = FileNode(id="f2", name="b.py")

        repo.add_child(NodeRelationship(target=file1, relationship="DEFINED_IN"))
        repo.add_child(NodeRelationship(target=file2, relationship="DEFINED_IN"))

        tree = TreeWithOrigin(root=repo, origin="code")
        result = await mapper.map_trees([tree])

        assert result.nodes_created == 3
        assert result.relationships_created == 2


class TestMappingResult:
    def test_defaults(self):
        r = MappingResult()
        assert r.nodes_created == 0
        assert r.relationships_created == 0
        assert r.errors == []
