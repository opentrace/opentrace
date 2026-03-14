"""Tests for opentrace_agent.cli.converter."""

from __future__ import annotations

from opentrace_agent.cli.converter import _normalize_rel_type, tree_to_batch
from opentrace_agent.models.base import NodeRelationship, TreeWithOrigin
from opentrace_agent.models.nodes import ClassNode, FileNode, FunctionNode, RepoNode


class TestNormalizeRelType:
    def test_known_types(self):
        assert _normalize_rel_type("defined_in") == "DEFINED_IN"
        assert _normalize_rel_type("calls") == "CALLS"
        assert _normalize_rel_type("parent_of") == "PART_OF"

    def test_unknown_type(self):
        assert _normalize_rel_type("custom_rel") == "CUSTOM_REL"


class TestTreeToBatch:
    def _make_simple_tree(self) -> TreeWithOrigin:
        """Build a small tree: Repo -> File -> Function."""
        repo = RepoNode(id="org/repo", name="repo", url="https://example.com")
        file_node = FileNode(
            id="org/repo/main.py",
            name="main.py",
            path="main.py",
            extension=".py",
            language="python",
        )
        func_node = FunctionNode(
            id="org/repo/main.py::greet",
            name="greet",
            language="python",
            start_line=1,
            end_line=2,
        )

        # File defined_in Repo (incoming: file -> repo)
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))
        # Function defined_in File (incoming: func -> file)
        file_node.add_child(
            NodeRelationship(target=func_node, relationship="DEFINED_IN")
        )

        return TreeWithOrigin(root=repo, origin="code")

    def test_collects_all_nodes(self):
        tree = self._make_simple_tree()
        nodes, rels = tree_to_batch(tree)

        node_ids = {n["id"] for n in nodes}
        assert node_ids == {"org/repo", "org/repo/main.py", "org/repo/main.py::greet"}

    def test_node_format(self):
        tree = self._make_simple_tree()
        nodes, _ = tree_to_batch(tree)

        repo_node = next(n for n in nodes if n["id"] == "org/repo")
        assert repo_node["type"] == "Repository"
        assert repo_node["name"] == "repo"
        assert "url" in repo_node["properties"]

    def test_relationship_format(self):
        tree = self._make_simple_tree()
        _, rels = tree_to_batch(tree)

        # Should have 2 relationships: file->repo, func->file
        assert len(rels) == 2
        for rel in rels:
            assert rel["id"].startswith("rel-")
            assert rel["type"] == "DEFINED_IN"
            assert "source_id" in rel
            assert "target_id" in rel

    def test_incoming_direction(self):
        """Incoming rels should have target=child, source=child (child->parent)."""
        tree = self._make_simple_tree()
        _, rels = tree_to_batch(tree)

        # file defined_in repo: incoming means file->repo
        file_rel = next(
            r
            for r in rels
            if r["source_id"] == "org/repo/main.py" and r["target_id"] == "org/repo"
        )
        assert file_rel["type"] == "DEFINED_IN"

    def test_outgoing_direction(self):
        """Outgoing rels should have source=parent, target=child."""
        repo = RepoNode(id="r", name="r")
        func_a = FunctionNode(id="r/a.py::a", name="a")
        func_b = FunctionNode(id="r/a.py::b", name="b")

        # a calls b (outgoing: a -> b)
        func_a.add_child(
            NodeRelationship(target=func_b, relationship="CALLS", direction="outgoing")
        )
        repo.add_child(NodeRelationship(target=func_a, relationship="DEFINED_IN"))

        tree = TreeWithOrigin(root=repo, origin="code")
        _, rels = tree_to_batch(tree)

        calls_rel = next(r for r in rels if r["type"] == "CALLS")
        assert calls_rel["source_id"] == "r/a.py::a"
        assert calls_rel["target_id"] == "r/a.py::b"

    def test_no_duplicate_nodes(self):
        """Nodes appearing in multiple rels should only be emitted once."""
        repo = RepoNode(id="r", name="r")
        file_node = FileNode(id="r/f.py", name="f.py")
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        tree = TreeWithOrigin(root=repo, origin="code")
        nodes, _ = tree_to_batch(tree)

        ids = [n["id"] for n in nodes]
        assert len(ids) == len(set(ids))

    def test_empty_tree(self):
        repo = RepoNode(id="r", name="r")
        tree = TreeWithOrigin(root=repo, origin="code")
        nodes, rels = tree_to_batch(tree)

        assert len(nodes) == 1
        assert len(rels) == 0

    def test_node_properties(self):
        """graph_properties should appear in the output."""
        tree = self._make_simple_tree()
        nodes, _ = tree_to_batch(tree)

        func_node = next(n for n in nodes if n["id"] == "org/repo/main.py::greet")
        assert func_node["properties"]["language"] == "python"
        assert func_node["properties"]["start_line"] == 1
