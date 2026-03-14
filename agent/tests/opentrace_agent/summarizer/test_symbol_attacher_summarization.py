"""Tests for Phase 3 summarization in SymbolAttacher."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Sequence

import pytest

from opentrace_agent.models.base import NodeRelationship
from opentrace_agent.models.nodes import (
    ClassNode,
    FileNode,
    FunctionNode,
    RepoNode,
)
from opentrace_agent.sources.code.extractors.python_extractor import PythonExtractor
from opentrace_agent.sources.code.symbol_attacher import SymbolAttacher
from opentrace_agent.summarizer.base import NodeKind, SummarizerConfig


class FakeSummarizer:
    """A fake summarizer that returns predictable summaries."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, NodeKind]] = []

    async def init(self) -> None:
        pass

    async def summarize(self, source: str, kind: NodeKind) -> str:
        self.calls.append((source[:50], kind))
        return f"Summary of {kind}"

    async def summarize_batch(
        self,
        items: Sequence[tuple[str, NodeKind]],
    ) -> list[str]:
        results = []
        for source, kind in items:
            results.append(await self.summarize(source, kind))
        return results

    async def dispose(self) -> None:
        pass


SAMPLE_PYTHON = '''\
class Greeter:
    """A simple greeter class."""

    def greet(self, name: str) -> str:
        return f"Hello, {name}!"


def standalone():
    pass
'''


class TestSymbolAttacherSummarization:
    def test_attach_with_summarizer_adds_summaries(self, tmp_path: Path):
        """Phase 3 should add summary fields to file, class, and function nodes."""
        # Write a sample Python file
        py_file = tmp_path / "greeter.py"
        py_file.write_text(SAMPLE_PYTHON)

        # Build a mini tree
        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/greeter.py",
            name="greeter.py",
            path="greeter.py",
            extension=".py",
            language="python",
            abs_path=str(py_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        fake_summarizer = FakeSummarizer()
        attacher = SymbolAttacher(
            extractors=[PythonExtractor()],
            summarizer=fake_summarizer,
        )
        counters = attacher.attach(repo)

        # Summaries should have been generated
        assert counters["summaries"] > 0

        # The file node should have a summary
        assert file_node.summary is not None
        assert file_node.summary == "Summary of file"

        # Check that class and function children also got summaries
        summaries_found = 0
        for rel in file_node.children:
            node = rel.target
            if isinstance(node, ClassNode):
                assert node.summary == "Summary of class"
                summaries_found += 1
                # Check methods inside the class
                for child_rel in node.children:
                    if isinstance(child_rel.target, FunctionNode):
                        assert child_rel.target.summary == "Summary of function"
                        summaries_found += 1
            elif isinstance(node, FunctionNode):
                assert node.summary == "Summary of function"
                summaries_found += 1

        assert summaries_found >= 2, (
            f"Expected at least 2 summarized nodes, got {summaries_found}"
        )

    def test_attach_without_summarizer_skips_phase3(self, tmp_path: Path):
        """When no summarizer is provided, no summaries should be generated."""
        py_file = tmp_path / "simple.py"
        py_file.write_text("def foo(): pass\n")

        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/simple.py",
            name="simple.py",
            path="simple.py",
            extension=".py",
            language="python",
            abs_path=str(py_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher(extractors=[PythonExtractor()])
        counters = attacher.attach(repo)

        assert counters.get("summaries", 0) == 0
        assert file_node.summary is None
