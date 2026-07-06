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

"""End-to-end pipeline tests with real multi-file projects."""

from __future__ import annotations

from pathlib import Path

from opentrace_agent.pipeline import (
    EventKind,
    MemoryStore,
    PipelineInput,
    collect_pipeline,
)


def _make_multi_file_project(tmp_path: Path) -> Path:
    """Create a small Python project with cross-file calls."""
    (tmp_path / "main.py").write_text(
        "from utils import helper\n\ndef main():\n    result = helper()\n    return result\n"
    )
    (tmp_path / "utils.py").write_text("def helper():\n    return 42\n")
    (tmp_path / "models.py").write_text(
        "class User:\n"
        "    def __init__(self, name):\n"
        "        self.name = name\n"
        "\n"
        "    def greet(self):\n"
        "        return f'Hello, {self.name}'\n"
    )
    return tmp_path


def test_end_to_end_pipeline(tmp_path: Path) -> None:
    root = _make_multi_file_project(tmp_path)
    inp = PipelineInput(path=str(root), repo_id="test/project")

    events, nodes, rels = collect_pipeline(inp)

    # Should have events from all stages
    phases = {e.phase.value for e in events}
    assert "scanning" in phases
    assert "processing" in phases
    assert "resolving" in phases

    # Should end with DONE
    done_events = [e for e in events if e.kind == EventKind.DONE]
    assert len(done_events) == 1
    result = done_events[0].result
    assert result is not None
    assert result.files_processed == 3
    assert result.classes_extracted >= 1  # User
    assert result.functions_extracted >= 3  # main, helper, __init__, greet

    # Node types
    node_types = {n.type for n in nodes}
    assert "Repository" in node_types
    assert "File" in node_types
    assert "Class" in node_types
    assert "Function" in node_types

    # Relationship types
    rel_types = {r.type for r in rels}
    assert "DEFINES" in rel_types
    # CALLS should exist (self.name in greet, or import-based calls)


def test_pipeline_with_memory_store(tmp_path: Path) -> None:
    root = _make_multi_file_project(tmp_path)
    inp = PipelineInput(path=str(root), repo_id="test/project")
    store = MemoryStore()

    events, _, _ = collect_pipeline(inp, store=store)

    # Store should have all nodes and relationships
    assert len(store.nodes) > 0
    assert len(store.relationships) > 0

    # Every node from events should be in the store
    all_event_node_ids = set()
    for e in events:
        if e.nodes:
            for n in e.nodes:
                all_event_node_ids.add(n.id)

    for nid in all_event_node_ids:
        assert nid in store.nodes, f"Node {nid} not found in store"


def test_pipeline_go_project(tmp_path: Path) -> None:
    """Pipeline handles Go files correctly."""
    (tmp_path / "main.go").write_text('package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("hello")\n}\n')
    (tmp_path / "handler.go").write_text(
        "package main\n\n"
        "type Server struct{}\n\n"
        "func (s *Server) Handle() {\n"
        "    s.validate()\n"
        "}\n\n"
        "func (s *Server) validate() {}\n"
    )

    inp = PipelineInput(path=str(tmp_path), repo_id="test/goproject")
    events, nodes, rels = collect_pipeline(inp)

    done_events = [e for e in events if e.kind == EventKind.DONE]
    assert len(done_events) == 1
    result = done_events[0].result
    assert result is not None
    assert result.files_processed == 2


def test_pipeline_ts_project(tmp_path: Path) -> None:
    """Pipeline handles TypeScript files."""
    (tmp_path / "app.ts").write_text("export class App {\n  run(): void {\n    console.log('running');\n  }\n}\n")

    inp = PipelineInput(path=str(tmp_path), repo_id="test/tsproject")
    events, nodes, rels = collect_pipeline(inp)

    done_events = [e for e in events if e.kind == EventKind.DONE]
    assert len(done_events) == 1
    result = done_events[0].result
    assert result is not None
    assert result.files_processed == 1
    assert result.classes_extracted >= 1


def test_pipeline_empty_directory(tmp_path: Path) -> None:
    """Pipeline handles an empty directory gracefully."""
    inp = PipelineInput(path=str(tmp_path), repo_id="test/empty")

    events, nodes, rels = collect_pipeline(inp)

    done_events = [e for e in events if e.kind == EventKind.DONE]
    assert len(done_events) == 1
    result = done_events[0].result
    assert result is not None
    assert result.files_processed == 0

    # Should still have the repo node
    repo_nodes = [n for n in nodes if n.type == "Repository"]
    assert len(repo_nodes) == 1


def test_pipeline_repo_id_defaults_to_dir_name(tmp_path: Path) -> None:
    """When repo_id is not set, it defaults to the directory name."""
    (tmp_path / "main.py").write_text("x = 1\n")
    inp = PipelineInput(path=str(tmp_path))

    events, nodes, rels = collect_pipeline(inp)

    repo_nodes = [n for n in nodes if n.type == "Repository"]
    assert len(repo_nodes) == 1
    assert repo_nodes[0].id == tmp_path.name


def test_dependency_nodes_are_never_orphaned(tmp_path: Path) -> None:
    """Invariant: every Dependency node has at least one incoming edge.

    Both Dependency-creation paths — manifest parsing in `scanning.py`
    (emits Repository -[DEPENDS_ON]-> Dependency) and external-import
    analysis in `processing.py` (emits File -[IMPORTS]-> Dependency) —
    must create the edge in the same step as the node. The UI-side
    orphan sweep in `deleteRepo` relies on this: a Dependency with no
    incoming edges after a repo's rels are removed must have been
    exclusively referenced by that repo. If a third creation path ever
    emits an orphan Dependency, the sweep would wrongly delete
    legitimately-shared packages on repo removal.
    """
    # requirements.txt declares packages; one of them (requests) is
    # also imported by code, the other two are manifest-only. The code
    # also imports numpy, which is not declared in requirements.txt.
    # This covers all three possible Dependency provenances in one
    # fixture: manifest-only, import-only, and both.
    (tmp_path / "requirements.txt").write_text("requests==2.31.0\npyyaml==6.0\nclick==8.1.7\n")
    (tmp_path / "app.py").write_text(
        "import requests\nimport numpy\n\ndef fetch():\n    return requests.get('https://example.com')\n"
    )

    inp = PipelineInput(path=str(tmp_path), repo_id="test/deps")
    _, nodes, rels = collect_pipeline(inp)

    dep_nodes = [n for n in nodes if n.type == "Dependency"]
    # Fixture sanity: make sure the pipeline actually produced Dependency
    # nodes; otherwise the invariant check below is vacuous.
    assert dep_nodes, "Expected Dependency nodes from fixture but got none"

    rel_targets = {r.target_id for r in rels}
    orphans = sorted(n.id for n in dep_nodes if n.id not in rel_targets)
    assert orphans == [], (
        f"Found orphan Dependency nodes with no incoming edges: {orphans}. "
        "This breaks the UI-side deleteRepo orphan sweep — see "
        "ui/src/store/ladybugStore.ts sweepOrphanedDependencies."
    )


def test_dependency_nodes_emitted_no_later_than_their_rels(tmp_path: Path) -> None:
    """Invariant: a rel's endpoints appear as nodes in the same or an
    earlier event.

    GraphStoreAdapter flushes rel batches mid-stage, and the store's FK
    filter permanently drops rels whose endpoints aren't in the DB yet
    (they are never retried). Deferring Dependency nodes to an
    end-of-stage event therefore silently lost every
    File-[IMPORTS]->Dependency edge on repos larger than one batch.
    """
    (tmp_path / "a.py").write_text("import requests\n\ndef a():\n    return requests.get\n")
    (tmp_path / "b.py").write_text("import requests\nimport numpy\n\ndef b():\n    return numpy.array\n")

    inp = PipelineInput(path=str(tmp_path), repo_id="test/dep-order")
    events, _, rels = collect_pipeline(inp)

    pkg_rels = [r for r in rels if r.target_id.startswith("pkg:")]
    assert pkg_rels, "Expected File-[IMPORTS]->pkg:* rels from fixture but got none"

    seen_node_ids: set[str] = set()
    for event in events:
        # Within one event the saving stage persists nodes before rels,
        # so same-event node+rel is safe.
        for node in event.nodes or []:
            seen_node_ids.add(node.id)
        for rel in event.relationships or []:
            if rel.target_id.startswith("pkg:"):
                assert rel.target_id in seen_node_ids, (
                    f"Rel {rel.id} was emitted before its Dependency node "
                    f"{rel.target_id} — a mid-stage rel flush would drop it."
                )


def test_non_utf8_file_is_skipped_not_fatal(tmp_path: Path) -> None:
    """A single file in another encoding must be skipped, not abort the run.

    Extractors decode tree-sitter node bytes as UTF-8; a legal latin-1
    source file used to raise UnicodeDecodeError out of the pipeline,
    killing the entire index (and the CLI then deleted the staging DB).
    """
    # Legal latin-1 Python file: é in a docstring, undecodable as UTF-8.
    (tmp_path / "legacy.py").write_text(
        '# -*- coding: latin-1 -*-\ndef caf():\n    """Un caf\xe9."""\n    return 1\n',
        encoding="latin-1",
    )
    (tmp_path / "good.py").write_text("def fine():\n    return 42\n")

    inp = PipelineInput(path=str(tmp_path), repo_id="test/encoding")
    events, nodes, _ = collect_pipeline(inp)

    # Pipeline ran to completion.
    done_events = [e for e in events if e.kind == EventKind.DONE]
    assert len(done_events) == 1
    result = done_events[0].result
    assert result is not None

    # The good file was fully indexed (function names include the signature).
    fn_names = {n.name for n in nodes if n.type == "Function"}
    assert any(name.startswith("fine") for name in fn_names)

    # The bad file was recorded as an error, not silently swallowed.
    assert any("legacy.py" in e for e in result.errors)
