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

"""Stage 1: Scanning — walk directory tree to produce structural nodes."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Generator

from opentrace_agent.pipeline.types import (
    EventKind,
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
    DirectoryWalker,
)
from opentrace_agent.sources.code.import_analyzer import (
    package_id,
    package_source_url,
)
from opentrace_agent.sources.code.manifest_parser import (
    extract_go_module_path,
    parse_manifest,
)

logger = logging.getLogger(__name__)


def scanning(
    inp: PipelineInput,
    ctx: PipelineContext,
    out: StageResult[ScanResult],
) -> Generator[PipelineEvent, None, None]:
    """Walk directory tree and produce structural GraphNode/GraphRelationship objects."""
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

    # Walk directory tree → flat nodes/rels
    walker = DirectoryWalker()
    walk = walker.walk(
        root_path=root_path,
        repo_id=repo_id,
        repo_name=root_path.name,
    )

    if ctx.cancelled:
        return

    nodes = walk.nodes
    rels = walk.relationships

    # Enrich Repository node with ref/sourceUri/provider
    for node in nodes:
        if node.type == "Repository":
            props = dict(node.properties or {})
            props["summary"] = f"Source code repository for {node.name}"
            if ref:
                props["ref"] = ref
            if repo_url:
                props["sourceUri"] = repo_url
            if provider:
                props["provider"] = provider
            nodes[nodes.index(node)] = GraphNode(
                id=node.id,
                type=node.type,
                name=node.name,
                properties=props,
            )
            break

    # Enrich File nodes with sourceUri
    if repo_url and ref:
        for i, node in enumerate(nodes):
            if node.type == "File":
                path = (node.properties or {}).get("path")
                if path:
                    props = dict(node.properties or {})
                    props["sourceUri"] = f"{repo_url}/blob/{ref}/{path}"
                    nodes[i] = GraphNode(
                        id=node.id,
                        type=node.type,
                        name=node.name,
                        properties=props,
                    )

    # Parse manifest files → Package nodes + DEPENDS_ON rels
    go_module_path: str | None = None
    package_nodes: dict[str, GraphNode] = {}
    seen_dep_rels: set[str] = set()

    for manifest_path, manifest_abs_path in walk.manifest_files:
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
                    pkg_props["sourceUri"] = source_url
                package_nodes[pkg_id] = GraphNode(
                    id=pkg_id,
                    type="Dependency",
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
        message=f"Scanned {len(nodes)} nodes, {len(walk.file_entries)} parseable files",
        detail=ProgressDetail(current=len(nodes), total=len(nodes)),
        nodes=nodes,
        relationships=rels,
    )

    out.value = ScanResult(
        repo_id=repo_id,
        root_path=str(root_path),
        structural_nodes=nodes,
        structural_relationships=rels,
        file_entries=walk.file_entries,
        known_paths=walk.known_paths,
        path_to_file_id=walk.path_to_file_id,
        go_module_path=go_module_path,
        repo_url=repo_url,
        ref=ref,
        provider=provider,
    )
