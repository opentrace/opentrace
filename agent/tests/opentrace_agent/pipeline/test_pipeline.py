"""End-to-end pipeline tests with real multi-file projects."""

from __future__ import annotations

from pathlib import Path

from opentrace_agent.pipeline import (
    EventKind,
    GraphNode,
    GraphRelationship,
    MemoryStore,
    PipelineInput,
    collect_pipeline,
    run_pipeline,
)


def _make_multi_file_project(tmp_path: Path) -> Path:
    """Create a small Python project with cross-file calls."""
    (tmp_path / "main.py").write_text(
        "from utils import helper\n"
        "\n"
        "def main():\n"
        "    result = helper()\n"
        "    return result\n"
    )
    (tmp_path / "utils.py").write_text(
        "def helper():\n"
        "    return 42\n"
    )
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
    assert "DEFINED_IN" in rel_types
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
    (tmp_path / "main.go").write_text(
        'package main\n\n'
        'import "fmt"\n\n'
        'func main() {\n'
        '    fmt.Println("hello")\n'
        '}\n'
    )
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
    (tmp_path / "app.ts").write_text(
        "export class App {\n"
        "  run(): void {\n"
        "    console.log('running');\n"
        "  }\n"
        "}\n"
    )

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
