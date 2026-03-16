"""Tests for opentrace_agent.models.base."""

import pytest

from opentrace_agent.models.base import (
    BaseTreeNode,
    NodeRelationship,
    TreeWithOrigin,
    calculate_string_hash,
)
from opentrace_agent.models.nodes import (
    DirectoryNode,
    FileNode,
    IssueNode,
    RepoNode,
)


class TestBaseTreeNode:
    def test_requires_graph_type(self):
        with pytest.raises(ValueError, match="must define 'graph_type'"):

            class BadNode(BaseTreeNode):
                save_function_name = "save_bad_node"  # type: ignore[assignment]

            BadNode(id="x", name="x")

    def test_requires_save_function_name(self):
        with pytest.raises(ValueError, match="must define 'save_function_name'"):

            class BadNode(BaseTreeNode):
                graph_type = "Bad"  # type: ignore[assignment]

            BadNode(id="x", name="x")

    def test_base_node_itself_ok(self):
        node = BaseTreeNode(id="test", name="Test")
        assert node.type == "BaseTreeNode"

    def test_add_child(self):
        repo = RepoNode(id="r", name="repo")
        file_node = FileNode(id="f", name="file.py", path="file.py")
        rel = NodeRelationship(target=file_node, relationship="DEFINED_IN")
        repo.add_child(rel)

        assert len(repo.children) == 1
        assert file_node.parent is repo

    def test_find_parent(self):
        repo = RepoNode(id="r", name="repo")
        dir_node = DirectoryNode(id="d", name="src", path="src")
        file_node = FileNode(id="f", name="main.py", path="src/main.py")

        repo.add_child(NodeRelationship(target=dir_node, relationship="DEFINED_IN"))
        dir_node.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        assert file_node.find_parent(RepoNode) is repo
        assert file_node.find_parent(DirectoryNode) is dir_node
        assert file_node.find_parent(IssueNode) is None

    def test_graph_properties(self):
        node = RepoNode(
            id="org/repo",
            name="repo",
            url="https://github.com/org/repo",
            default_branch="main",
            content_hash="abc123",
        )
        props = node.graph_properties
        assert props["url"] == "https://github.com/org/repo"
        assert props["default_branch"] == "main"
        assert props["content_hash"] == "abc123"


class TestNodeRelationship:
    def test_save_function_name(self):
        rel = NodeRelationship(
            target=FileNode(id="f", name="f"),
            relationship="DEFINED_IN",
        )
        assert rel.save_function_name == "save_defined_in_relationship"

    def test_invalid_relationship(self):
        rel = NodeRelationship(
            target=FileNode(id="f", name="f"),
            relationship="nonexistent",  # type: ignore[arg-type]
        )
        with pytest.raises(ValueError, match="Could not determine MCP operation"):
            _ = rel.save_function_name

    def test_graph_properties_are_copy(self):
        props = {"key": "value"}
        rel = NodeRelationship(
            target=FileNode(id="f", name="f"),
            relationship="DEFINED_IN",
            properties=props,
        )
        graph_props = rel.graph_properties
        graph_props["extra"] = "added"
        assert "extra" not in rel.properties


class TestTreeWithOrigin:
    def test_basic(self):
        root = RepoNode(id="r", name="repo")
        tree = TreeWithOrigin(root=root, origin="code", counters={"repos": 1})
        assert tree.origin == "code"
        assert tree.counters["repos"] == 1


class TestCalculateStringHash:
    def test_empty_string(self):
        assert calculate_string_hash("") == ""

    def test_deterministic(self):
        h1 = calculate_string_hash("hello")
        h2 = calculate_string_hash("hello")
        assert h1 == h2
        assert len(h1) == 64  # SHA-256 hex digest
