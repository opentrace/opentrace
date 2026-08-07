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

"""Doc-awareness notes appended to the MCP tool descriptions.

``create_mcp_server`` reaches into ``server._tool_manager._tools`` — FastMCP
privates — to append a documentation note to three tool descriptions when the
open index actually contains ``KnowledgeDoc`` nodes. ``wiki/CLAUDE.md`` treats
that advertisement as load-bearing: it is how an agent learns the doc layer
exists at all.

The lookup is ``.get(tool_name)`` guarded by ``if tool is not None``, so a
renamed tool degrades to a silent no-op rather than an error. These tests are
what turn that silence back into a failure.
"""

from __future__ import annotations

import pytest

pytest.importorskip("real_ladybug")

from opentrace_agent.cli.mcp_server import (  # noqa: E402
    _DOC_EDGES_NOTE,
    _DOC_HITS_NOTE,
    _DOC_TYPES_NOTE,
    create_mcp_server,
)
from opentrace_agent.store import GraphStore  # noqa: E402

#: Tool name → the note its description must carry on a doc-bearing index.
ANNOTATED_TOOLS = {
    "list_nodes": _DOC_TYPES_NOTE,
    "search_graph": _DOC_HITS_NOTE,
    "traverse_graph": _DOC_EDGES_NOTE,
}


def _description(store: GraphStore | None, tool_name: str) -> str:
    server = create_mcp_server(store)
    tool = server._tool_manager._tools.get(tool_name)
    assert tool is not None, (
        f"{tool_name!r} is missing from FastMCP's tool registry — either the tool was "
        "renamed or the private registry layout changed. create_mcp_server's doc-note "
        "pass looks tools up the same way and would silently skip them."
    )
    return tool.description or ""


@pytest.fixture()
def docs_store(tmp_path):
    """An index containing one KnowledgeDoc — enough to trip `_graph_has_docs`."""
    s = GraphStore(str(tmp_path / "docs-db"))
    s.add_node(
        "corpus::aaa",
        "KnowledgeDoc",
        "guide.md",
        properties={"sha256": "aaa", "filename": "guide.md", "title": "Guide"},
    )
    yield s
    s.close()


@pytest.fixture()
def code_only_store(tmp_path):
    """A code-only index — no KnowledgeDoc anywhere."""
    s = GraphStore(str(tmp_path / "code-db"))
    s.add_node("f0", "Function", "handler")
    yield s
    s.close()


class TestDocNotesOnDocBearingIndex:
    @pytest.mark.parametrize("tool_name", sorted(ANNOTATED_TOOLS))
    def test_note_is_appended(self, docs_store, tool_name):
        description = _description(docs_store, tool_name)

        assert ANNOTATED_TOOLS[tool_name].strip() in description

    @pytest.mark.parametrize("tool_name", sorted(ANNOTATED_TOOLS))
    def test_original_description_survives(self, docs_store, code_only_store, tool_name):
        """The note is appended, not substituted."""
        base = _description(code_only_store, tool_name)
        annotated = _description(docs_store, tool_name)

        assert base, f"{tool_name} has no baseline description to append to"
        assert annotated.startswith(base.rstrip())
        assert len(annotated) > len(base)


class TestNoNotesWithoutDocs:
    @pytest.mark.parametrize("tool_name", sorted(ANNOTATED_TOOLS))
    def test_code_only_index_is_not_annotated(self, code_only_store, tool_name):
        """Advertising a doc layer that isn't there sends the agent chasing it."""
        description = _description(code_only_store, tool_name)

        assert ANNOTATED_TOOLS[tool_name].strip() not in description

    @pytest.mark.parametrize("tool_name", sorted(ANNOTATED_TOOLS))
    def test_absent_store_is_not_annotated(self, tool_name):
        """No index at all must not claim documentation either."""
        description = _description(None, tool_name)

        assert ANNOTATED_TOOLS[tool_name].strip() not in description
