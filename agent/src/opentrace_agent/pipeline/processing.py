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
    DerivationInfo,
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
    SymbolInfo,
)
from opentrace_agent.sources.code.extractors import (
    GoExtractor,
    PythonExtractor,
    SymbolExtractor,
    TypeScriptExtractor,
)
from opentrace_agent.sources.code.extractors.base import CodeSymbol, VariableSymbol
from opentrace_agent.sources.code.extractors.typescript_extractor import (
    TypeScriptExtractor as TSExtractor,
)
from opentrace_agent.sources.code.import_analyzer import (
    ImportResult,
    analyze_go_imports,
    analyze_python_imports,
    analyze_typescript_imports,
    package_source_url,
)

logger = logging.getLogger(__name__)

_DEFAULT_EXTRACTORS: list[SymbolExtractor] = [
    PythonExtractor(),
    TypeScriptExtractor(),
    GoExtractor(),
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
    3. Convert CodeSymbol → GraphNode + GraphRelationship (DEFINES)
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
    derivation_infos: list[DerivationInfo] = []
    emitted_ids: set[str] = set()
    package_nodes: dict[str, GraphNode] = {}
    total_classes = 0
    total_functions = 0
    total_variables = 0
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
                        pkg_props["sourceUri"] = source_url
                    package_nodes[pkg_id] = GraphNode(
                        id=pkg_id,
                        type="Dependency",
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
            nodes, rels, sym_infos, calls, derivs, c, f, v = _symbol_to_graph(
                symbol,
                file_id,
                result.language,
                registries,
                emitted_ids,
            )
            file_nodes.extend(nodes)
            file_rels.extend(rels)
            total_classes += c
            total_functions += f
            total_variables += v

            # Register symbols
            for si in sym_infos:
                _register_symbol(si, registries)

            call_infos.extend(calls)
            derivation_infos.extend(derivs)

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
        message=(
            f"Extracted {total_classes} classes, {total_functions} functions, "
            f"{total_variables} variables from {files_processed} files"
        ),
    )

    out.value = ProcessingOutput(
        registries=registries,
        call_infos=call_infos,
        derivation_infos=derivation_infos,
        nodes_created=total_nodes,
        relationships_created=total_rels,
        files_processed=files_processed,
        classes_extracted=total_classes,
        functions_extracted=total_functions,
        variables_extracted=total_variables,
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
    return ImportResult()


def _symbol_to_graph(
    symbol: CodeSymbol,
    parent_id: str,
    language: str,
    registries: Registries,
    emitted_ids: set[str] | None = None,
) -> tuple[
    list[GraphNode],
    list[GraphRelationship],
    list[SymbolInfo],
    list[CallInfo],
    list[DerivationInfo],
    int,  # classes
    int,  # functions
    int,  # variables
]:
    """Convert a CodeSymbol tree into flat GraphNode/GraphRelationship lists.

    Returns (nodes, rels, symbol_infos, call_infos, derivation_infos,
             classes_count, functions_count, variables_count).
    """
    nodes: list[GraphNode] = []
    rels: list[GraphRelationship] = []
    sym_infos: list[SymbolInfo] = []
    call_infos: list[CallInfo] = []
    derivation_infos: list[DerivationInfo] = []
    classes = 0
    functions = 0
    variables = 0

    file_id = parent_id.split("::")[0]
    sig = symbol.type_signature or ""
    name_part = f"{symbol.receiver_type}.{symbol.name}{sig}" if symbol.receiver_type else f"{symbol.name}{sig}"
    node_id = f"{parent_id}::{name_part}"

    # Deduplication guard
    if emitted_ids is not None:
        if node_id in emitted_ids:
            return nodes, rels, sym_infos, call_infos, derivation_infos, classes, functions, variables
        emitted_ids.add(node_id)

    if symbol.kind == "class":
        props: dict[str, str | int | list[str] | None] = {"language": language}
        if symbol.start_line is not None:
            props["start_line"] = symbol.start_line
        if symbol.end_line is not None:
            props["end_line"] = symbol.end_line
        if symbol.superclasses:
            props["superclasses"] = symbol.superclasses
        if symbol.interfaces:
            props["interfaces"] = symbol.interfaces
        if symbol.subtype:
            props["subtype"] = symbol.subtype
        if symbol.docs:
            props["docs"] = symbol.docs
        nodes.append(GraphNode(id=node_id, type="Class", name=symbol.name, properties=props))
        classes = 1

        si = SymbolInfo(
            node_id=node_id,
            name=symbol.name,
            kind="class",
            file_id=file_id,
            language=language,
        )

        # Parent defines this class (File → Class, or outer Class → inner Class)
        rels.append(
            GraphRelationship(
                id=f"{parent_id}->DEFINES->{node_id}",
                type="DEFINES",
                source_id=parent_id,
                target_id=node_id,
                properties={},
            )
        )

        # Variables (class fields)
        var_nodes, var_rels, var_derivs, v = _variables_to_graph(
            symbol.variables, node_id, file_id, language, registries
        )
        nodes.extend(var_nodes)
        rels.extend(var_rels)
        derivation_infos.extend(var_derivs)
        variables += v

        # Process child methods
        for child_sym in symbol.children:
            child_nodes, child_rels, child_sis, child_calls, child_derivs, c, f, cv = _symbol_to_graph(
                child_sym, node_id, language, registries, emitted_ids
            )
            nodes.extend(child_nodes)
            rels.extend(child_rels)
            call_infos.extend(child_calls)
            derivation_infos.extend(child_derivs)
            classes += c
            functions += f
            variables += cv
            si.children.extend(child_sis)
            for child_si in child_sis:
                sym_infos.append(child_si)

        sym_infos.append(si)
    else:
        props = {"language": language}
        if symbol.start_line is not None:
            props["start_line"] = symbol.start_line
        if symbol.end_line is not None:
            props["end_line"] = symbol.end_line
        if symbol.signature:
            props["signature"] = symbol.signature
        if symbol.type_signature:
            props["type_signature"] = symbol.type_signature
        if symbol.return_type:
            props["return_type"] = symbol.return_type
        if symbol.docs:
            props["docs"] = symbol.docs
        display_name = f"{symbol.name}{symbol.signature}" if symbol.signature else symbol.name
        nodes.append(GraphNode(id=node_id, type="Function", name=display_name, properties=props))
        functions = 1

        si = SymbolInfo(
            node_id=node_id,
            name=symbol.name,
            kind="function",
            file_id=file_id,
            language=language,
            receiver_var=symbol.receiver_var,
            receiver_type=symbol.receiver_type,
            param_types=symbol.param_types,
        )
        sym_infos.append(si)

        # Parent defines this function (File → Function, or Class → Method)
        rels.append(
            GraphRelationship(
                id=f"{parent_id}->DEFINES->{node_id}",
                type="DEFINES",
                source_id=parent_id,
                target_id=node_id,
                properties={},
            )
        )

        # Variables (parameters + locals)
        var_nodes, var_rels, var_derivs, v = _variables_to_graph(
            symbol.variables, node_id, file_id, language, registries
        )
        nodes.extend(var_nodes)
        rels.extend(var_rels)
        derivation_infos.extend(var_derivs)
        variables += v

        # Collect calls for later resolution
        if symbol.calls:
            call_infos.append(
                CallInfo(
                    caller_id=node_id,
                    caller_name=symbol.name,
                    file_id=file_id,
                    calls=[(c.name, c.receiver, c.kind) for c in symbol.calls],
                    receiver_var=symbol.receiver_var,
                    receiver_type=symbol.receiver_type,
                    param_types=symbol.param_types,
                )
            )

    return nodes, rels, sym_infos, call_infos, derivation_infos, classes, functions, variables


def _variables_to_graph(
    variables: list[VariableSymbol],
    scope_id: str,
    file_id: str,
    language: str,
    registries: Registries,
) -> tuple[list[GraphNode], list[GraphRelationship], list[DerivationInfo], int]:
    """Convert VariableSymbol list into graph nodes, DEFINES rels, and derivation infos.

    Returns (nodes, relationships, derivation_infos, variable_count).
    """
    nodes: list[GraphNode] = []
    rels: list[GraphRelationship] = []
    derivs: list[DerivationInfo] = []
    count = 0

    scope_vars = registries.variable_registry.setdefault(scope_id, {})

    for var in variables:
        var_id = f"{scope_id}::{var.name}"
        props: dict[str, str | int | bool | None] = {
            "language": language,
            "kind": var.kind,
        }
        if var.start_line is not None:
            props["startLine"] = var.start_line
        if var.end_line is not None:
            props["endLine"] = var.end_line
        if var.type_annotation:
            props["typeAnnotation"] = var.type_annotation

        nodes.append(GraphNode(id=var_id, type="Variable", name=var.name, properties=props))
        rels.append(
            GraphRelationship(
                id=f"{scope_id}->DEFINES->{var_id}",
                type="DEFINES",
                source_id=scope_id,
                target_id=var_id,
                properties={},
            )
        )
        scope_vars[var.name] = var_id
        count += 1

        # Queue derivation refs for resolution
        if var.derived_from:
            # For fields extracted from a method (e.g., self.x in __init__),
            # resolve derivations using that method's scope, not the class scope.
            deriv_scope = f"{scope_id}::{var.origin_scope}" if var.origin_scope else scope_id
            derivs.append(
                DerivationInfo(
                    variable_id=var_id,
                    scope_id=deriv_scope,
                    file_id=file_id,
                    refs=[(d.name, d.receiver, d.kind) for d in var.derived_from],
                )
            )

    return nodes, rels, derivs, count


def _register_symbol(si: SymbolInfo, registries: Registries) -> None:
    """Add a SymbolInfo to all relevant registries."""
    registries.name_registry.setdefault(si.name, []).append(si)
    registries.file_registry.setdefault(si.file_id, {})[si.name] = si
    if si.kind == "class":
        registries.class_registry.setdefault(si.name, []).append(si)
