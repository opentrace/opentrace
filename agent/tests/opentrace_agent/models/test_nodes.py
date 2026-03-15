"""Tests for opentrace_agent.models.nodes."""

from opentrace_agent.models.nodes import (
    ClassNode,
    CommentNode,
    DirectoryNode,
    FileNode,
    FunctionNode,
    IssueNode,
    ProjectNode,
    RepoNode,
    UserNode,
)


class TestConcreteNodes:
    def test_all_nodes_have_graph_type(self):
        nodes = [
            RepoNode(id="r", name="r"),
            DirectoryNode(id="d", name="d"),
            FileNode(id="f", name="f"),
            ClassNode(id="c", name="c"),
            FunctionNode(id="fn", name="fn"),
            ProjectNode(id="p", name="p"),
            IssueNode(id="i", name="i"),
            CommentNode(id="co", name="co"),
            UserNode(id="u", name="u"),
        ]
        for node in nodes:
            assert node.graph_type, f"{node.type} missing graph_type"
            assert node.save_function_name, f"{node.type} missing save_function_name"

    def test_issue_node_properties(self):
        issue = IssueNode(
            id="i",
            name="Bug",
            url="https://example.com/1",
            state="open",
            provider="github",
            labels=["bug", "critical"],
        )
        props = issue.graph_properties
        assert props["url"] == "https://example.com/1"
        assert props["state"] == "open"
        assert props["labels"] == ["bug", "critical"]
