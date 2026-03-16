"""Stage 1: Scanning — walk directory tree to produce structural nodes."""

from __future__ import annotations

import logging
from collections import deque
from pathlib import Path
from typing import Generator

from opentrace_agent.models.base import BaseTreeNode
from opentrace_agent.models.nodes import FileNode, RepoNode
from opentrace_agent.pipeline.types import (
    EventKind,
    FileEntry,
    GraphNode,
    GraphRelationship,
    Phase,
    PipelineContext,
    PipelineEvent,
    PipelineInput,
    ProgressDetail,
    ScanResult,
    StageResult,
)
from opentrace_agent.sources.code.directory_walker import (
    EXTENSION_LANGUAGE_MAP,
    DirectoryWalker,
)
from opentrace_agent.sources.code.extractors import (
    GoExtractor,
    PythonExtractor,
    SymbolExtractor,
    TypeScriptExtractor,
)
from opentrace_agent.sources.code.import_analyzer import (
    package_id,
    package_source_url,
)
from opentrace_agent.sources.code.manifest_parser import (
    extract_go_module_path,
    is_manifest_file,
    parse_manifest,
)

logger = logging.getLogger(__name__)

# Extensions handled by our extractors
_PARSEABLE_EXTENSIONS: frozenset[str] = frozenset()
_DEFAULT_EXTRACTORS: list[SymbolExtractor] = [
    PythonExtractor(),
    TypeScriptExtractor(),
    GoExtractor(),
]

for _ext in _DEFAULT_EXTRACTORS:
    _PARSEABLE_EXTENSIONS = _PARSEABLE_EXTENSIONS | frozenset(_ext.extensions)

# Relationship type normalization — only entries that actually appear.
_REL_TYPE_MAP: dict[str, str] = {
    "PARENT_OF": "PART_OF",
}


def _normalize_rel_type(rel_type: str) -> str:
    return _REL_TYPE_MAP.get(rel_type, rel_type.upper())


def scanning(
    inp: PipelineInput,
    ctx: PipelineContext,
    out: StageResult[ScanResult],
) -> Generator[PipelineEvent, None, None]:
    """Walk directory tree and produce structural GraphNode/GraphRelationship objects.

    Reuses DirectoryWalker to build the RepoNode tree, then BFS-flattens it
    into GraphNode/GraphRelationship lists (absorbing converter.py logic).
    """
    yield PipelineEvent(
        kind=EventKind.STAGE_START,
        phase=Phase.SCANNING,
        message="Scanning directory tree",
    )

    root_path = Path(inp.path) if inp.path else None
    if root_path is None:
        yield PipelineEvent(
            kind=EventKind.ERROR,
            phase=Phase.SCANNING,
            message="No path provided",
            errors=["PipelineInput.path is required for local scanning"],
        )
        return

    root_path = root_path.resolve()
    repo_id = inp.repo_id or root_path.name
    repo_url = inp.repo_url
    ref = inp.ref
    provider = inp.provider

    if ctx.cancelled:
        return

    # Use DirectoryWalker to build the tree
    walker = DirectoryWalker()
    repo_node = walker.walk(
        root_path=root_path,
        repo_id=repo_id,
        repo_name=root_path.name,
    )
    repo_node.summary = f"Source code repository for {repo_node.name}"

    if ctx.cancelled:
        return

    # BFS the tree to produce flat nodes/rels + collect file entries
    nodes: list[GraphNode] = []
    rels: list[GraphRelationship] = []
    file_entries: list[FileEntry] = []
    path_to_file_id: dict[str, str] = {}
    manifest_files: list[tuple[str, str]] = []  # (repo-relative path, abs_path)

    queue: deque[BaseTreeNode] = deque([repo_node])
    visited: set[str] = set()

    while queue:
        node = queue.popleft()
        if node.id in visited:
            continue
        visited.add(node.id)

        props = node.graph_properties

        # Enrich Repo node with ref/source_uri/provider
        if isinstance(node, RepoNode):
            if props is None:
                props = {}
            if ref:
                props["ref"] = ref
            if repo_url:
                props["source_uri"] = repo_url
            if provider:
                props["provider"] = provider

        # Enrich File nodes with source_uri
        if isinstance(node, FileNode) and node.path and repo_url and ref:
            if props is None:
                props = {}
            props["source_uri"] = f"{repo_url}/blob/{ref}/{node.path}"

        nodes.append(
            GraphNode(
                id=node.id,
                type=node.graph_type,
                name=node.graph_display_name,
                properties=props if props else {},
            )
        )

        # Collect parseable file entries and manifest files
        if isinstance(node, FileNode) and node.abs_path and node.extension:
            if node.path:
                path_to_file_id[node.path] = node.id
                # Check for manifest files
                if is_manifest_file(node.path):
                    manifest_files.append((node.path, node.abs_path))
            if node.extension in _PARSEABLE_EXTENSIONS:
                file_entries.append(
                    FileEntry(
                        file_id=node.id,
                        abs_path=node.abs_path,
                        path=node.path,
                        extension=node.extension,
                        language=EXTENSION_LANGUAGE_MAP.get(node.extension),
                    )
                )

        for child_rel in node.children:
            queue.append(child_rel.target)

            if child_rel.direction == "incoming":
                source_id = child_rel.target.id
                target_id = node.id
            else:
                source_id = node.id
                target_id = child_rel.target.id

            rel_props = child_rel.graph_properties
            rels.append(
                GraphRelationship(
                    id=f"{source_id}->{_normalize_rel_type(child_rel.relationship)}->{target_id}",
                    type=_normalize_rel_type(child_rel.relationship),
                    source_id=source_id,
                    target_id=target_id,
                    properties=rel_props if rel_props else {},
                )
            )

    known_paths = set(path_to_file_id.keys())

    # Parse manifest files → Package nodes + DEPENDS_ON rels
    go_module_path: str | None = None
    package_nodes: dict[str, GraphNode] = {}
    seen_dep_rels: set[str] = set()

    for manifest_path, manifest_abs_path in manifest_files:
        try:
            content = Path(manifest_abs_path).read_text(encoding="utf-8", errors="replace")
        except (OSError, IOError) as exc:
            logger.warning("Could not read manifest %s: %s", manifest_abs_path, exc)
            continue

        # Extract go module path from go.mod
        basename = manifest_path.rsplit("/", 1)[-1]
        if basename == "go.mod":
            go_module_path = extract_go_module_path(content)

        parsed_deps = parse_manifest(manifest_path, content)
        for dep in parsed_deps:
            pkg_id = package_id(dep.registry, dep.name)

            # Create Package node (deduplicated)
            if pkg_id not in package_nodes:
                pkg_props: dict[str, str] = {"registry": dep.registry}
                source_url = package_source_url(dep.registry, dep.name)
                if source_url:
                    pkg_props["source_uri"] = source_url
                package_nodes[pkg_id] = GraphNode(
                    id=pkg_id,
                    type="Package",
                    name=dep.name,
                    properties=pkg_props,
                )

            # DEPENDS_ON relationship (deduplicated by rel ID)
            rel_id = f"{repo_id}->DEPENDS_ON->{pkg_id}"
            if rel_id not in seen_dep_rels:
                seen_dep_rels.add(rel_id)
                rels.append(
                    GraphRelationship(
                        id=rel_id,
                        type="DEPENDS_ON",
                        source_id=repo_id,
                        target_id=pkg_id,
                        properties={
                            "version": dep.version,
                            "dependency_type": dep.dependency_type,
                            "source": dep.source,
                        },
                    )
                )

    # Add package nodes to the structural nodes list
    nodes.extend(package_nodes.values())

    yield PipelineEvent(
        kind=EventKind.STAGE_STOP,
        phase=Phase.SCANNING,
        message=f"Scanned {len(nodes)} nodes, {len(file_entries)} parseable files",
        detail=ProgressDetail(current=len(nodes), total=len(nodes)),
        nodes=nodes,
        relationships=rels,
    )

    out.value = ScanResult(
        repo_id=repo_id,
        root_path=str(root_path),
        structural_nodes=nodes,
        structural_relationships=rels,
        file_entries=file_entries,
        known_paths=known_paths,
        path_to_file_id=path_to_file_id,
        go_module_path=go_module_path,
        repo_url=repo_url,
        ref=ref,
        provider=provider,
    )
