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

"""Stage 2: Processing — extract symbols and analyze imports per file."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Generator

from opentrace_agent.pipeline.types import (
    CallInfo,
    EventKind,
    GraphNode,
    GraphRelationship,
    Phase,
    PipelineContext,
    PipelineEvent,
    ProcessingOutput,
    ProgressDetail,
    Registries,
    ScanResult,
    StageResult,
)
from opentrace_agent.sources.code.extractors import (
    GenericExtractor,
    GoExtractor,
    PythonExtractor,
    SymbolExtractor,
    TypeScriptExtractor,
)
from opentrace_agent.pipeline.symbol_graph import _register_symbol, _symbol_to_graph
from opentrace_agent.sources.code.extractors.typescript_extractor import (
    TypeScriptExtractor as TSExtractor,
)
from opentrace_agent.sources.code.import_analyzer import (
    ImportResult,
    analyze_go_imports,
    analyze_python_imports,
    analyze_ruby_imports,
    analyze_rust_imports,
    analyze_typescript_imports,
    package_source_url,
)

logger = logging.getLogger(__name__)

_DEFAULT_EXTRACTORS: list[SymbolExtractor] = [
    PythonExtractor(),
    TypeScriptExtractor(),
    GoExtractor(),
    GenericExtractor(),
]


def _find_extractor(
    extension: str,
    extractors: list[SymbolExtractor] | None = None,
) -> SymbolExtractor | None:
    for ext in extractors or _DEFAULT_EXTRACTORS:
        if ext.can_handle(extension):
            return ext
    return None


def processing(
    scan: ScanResult,
    ctx: PipelineContext,
    out: StageResult[ProcessingOutput],
) -> Generator[PipelineEvent, None, None]:
    """Extract symbols from each parseable file and build registries.

    Per file:
    1. Read source bytes from disk
    2. Run language-specific extractor
    3. Convert CodeSymbol → GraphNode + GraphRelationship (DEFINED_IN)
    4. Analyze imports using the same tree-sitter AST (no re-parse)
    5. Populate registries for call resolution
    """
    total = len(scan.file_entries)
    yield PipelineEvent(
        kind=EventKind.STAGE_START,
        phase=Phase.PROCESSING,
        message=f"Processing {total} files",
        detail=ProgressDetail(current=0, total=total),
    )

    registries = Registries()
    call_infos: list[CallInfo] = []
    emitted_ids: set[str] = set()
    package_nodes: dict[str, GraphNode] = {}
    total_classes = 0
    total_functions = 0
    total_nodes = 0
    total_rels = 0
    files_processed = 0
    errors: list[str] = []

    for i, fe in enumerate(scan.file_entries):
        if ctx.cancelled:
            return

        extractor = _find_extractor(fe.extension)
        if extractor is None:
            continue

        # Read source
        try:
            source_bytes = Path(fe.abs_path).read_bytes()
        except (OSError, IOError) as exc:
            logger.warning("Could not read %s: %s", fe.abs_path, exc)
            errors.append(f"Could not read {fe.abs_path}: {exc}")
            continue

        # Extract symbols
        if isinstance(extractor, TSExtractor):
            result = extractor.extract_for_extension(source_bytes, fe.extension)
        elif isinstance(extractor, GenericExtractor):
            result = extractor.extract_for_extension(source_bytes, fe.extension)
        else:
            result = extractor.extract(source_bytes)

        file_id = fe.file_id
        file_path = fe.path

        # Ensure file has an entry in file_registry
        if file_id not in registries.file_registry:
            registries.file_registry[file_id] = {}

        # Convert symbols to graph nodes
        file_nodes: list[GraphNode] = []
        file_rels: list[GraphRelationship] = []

        # Analyze imports using the SAME root_node (no re-parse!)
        if result.root_node is not None:
            import_result = _analyze_imports_from_node(
                result.root_node,
                result.language,
                file_path,
                scan.known_paths,
                scan.go_module_path,
            )
            # Internal imports → registry + IMPORTS rels
            if import_result.internal:
                id_imports: dict[str, str] = {}
                seen_target_files: set[str] = set()
                for alias, target_path in import_result.internal.items():
                    target_id = scan.path_to_file_id.get(target_path)
                    if target_id:
                        id_imports[alias] = target_id
                        if target_id not in seen_target_files:
                            seen_target_files.add(target_id)
                            file_rels.append(
                                GraphRelationship(
                                    id=f"{file_id}->IMPORTS->{target_id}",
                                    type="IMPORTS",
                                    source_id=file_id,
                                    target_id=target_id,
                                    properties={},
                                )
                            )
                if id_imports:
                    registries.import_registry[file_id] = id_imports

            # External imports → Package nodes + IMPORTS rels
            for pkg_name, pkg_id in import_result.external.items():
                if pkg_id not in package_nodes:
                    registry = pkg_id.split(":")[1]
                    pkg_props: dict[str, str] = {"registry": registry}
                    source_url = package_source_url(registry, pkg_name)
                    if source_url:
                        pkg_props["source_uri"] = source_url
                    package_nodes[pkg_id] = GraphNode(
                        id=pkg_id,
                        type="Package",
                        name=pkg_name,
                        properties=pkg_props,
                    )
                file_rels.append(
                    GraphRelationship(
                        id=f"{file_id}->IMPORTS->{pkg_id}",
                        type="IMPORTS",
                        source_id=file_id,
                        target_id=pkg_id,
                        properties={},
                    )
                )

        for symbol in result.symbols:
            nodes, rels, sym_infos, calls, c, f = _symbol_to_graph(
                symbol,
                file_id,
                result.language,
                emitted_ids,
            )
            file_nodes.extend(nodes)
            file_rels.extend(rels)
            total_classes += c
            total_functions += f

            # Register symbols
            for si in sym_infos:
                _register_symbol(si, registries)

            call_infos.extend(calls)

        files_processed += 1
        total_nodes += len(file_nodes)
        total_rels += len(file_rels)

        yield PipelineEvent(
            kind=EventKind.STAGE_PROGRESS,
            phase=Phase.PROCESSING,
            message=f"Processed {fe.path}",
            detail=ProgressDetail(current=i + 1, total=total, file_name=fe.path),
            nodes=file_nodes if file_nodes else None,
            relationships=file_rels if file_rels else None,
        )

    # Emit deduplicated Package nodes
    if package_nodes:
        pkg_node_list = list(package_nodes.values())
        total_nodes += len(pkg_node_list)
        yield PipelineEvent(
            kind=EventKind.STAGE_PROGRESS,
            phase=Phase.PROCESSING,
            message=f"Emitting {len(pkg_node_list)} package nodes",
            detail=ProgressDetail(current=total, total=total),
            nodes=pkg_node_list,
        )

    yield PipelineEvent(
        kind=EventKind.STAGE_STOP,
        phase=Phase.PROCESSING,
        message=(f"Extracted {total_classes} classes, {total_functions} functions from {files_processed} files"),
    )

    out.value = ProcessingOutput(
        registries=registries,
        call_infos=call_infos,
        nodes_created=total_nodes,
        relationships_created=total_rels,
        files_processed=files_processed,
        classes_extracted=total_classes,
        functions_extracted=total_functions,
        errors=errors,
    )


def _analyze_imports_from_node(
    root_node: object,
    language: str,
    file_path: str,
    known_paths: set[str],
    go_module_path: str | None = None,
) -> ImportResult:
    """Run language-specific import analysis using the already-parsed root node."""
    if language == "python":
        return analyze_python_imports(root_node, file_path, known_paths)  # type: ignore[arg-type]
    elif language == "go":
        return analyze_go_imports(root_node, known_paths, go_module_path)  # type: ignore[arg-type]
    elif language in ("typescript", "javascript"):
        return analyze_typescript_imports(root_node, file_path, known_paths)  # type: ignore[arg-type]
    elif language == "rust":
        return analyze_rust_imports(root_node, file_path, known_paths)  # type: ignore[arg-type]
    elif language == "ruby":
        return analyze_ruby_imports(root_node, file_path, known_paths)  # type: ignore[arg-type]
    return ImportResult()


