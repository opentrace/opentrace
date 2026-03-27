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

"""Symbol-to-graph conversion helpers extracted from processing stage."""

from __future__ import annotations

from opentrace_agent.pipeline.types import (
    CallInfo,
    GraphNode,
    GraphRelationship,
    Registries,
    SymbolInfo,
)
from opentrace_agent.sources.code.extractors.base import CodeSymbol


def _symbol_to_graph(
    symbol: CodeSymbol,
    parent_id: str,
    language: str,
    emitted_ids: set[str] | None = None,
) -> tuple[
    list[GraphNode],
    list[GraphRelationship],
    list[SymbolInfo],
    list[CallInfo],
    int,  # classes
    int,  # functions
]:
    """Convert a CodeSymbol tree into flat GraphNode/GraphRelationship lists.

    Returns (nodes, rels, symbol_infos, call_infos, classes_count, functions_count).
    """
    nodes: list[GraphNode] = []
    rels: list[GraphRelationship] = []
    sym_infos: list[SymbolInfo] = []
    call_infos: list[CallInfo] = []
    classes = 0
    functions = 0

    file_id = parent_id.split("::")[0]
    name_part = f"{symbol.receiver_type}.{symbol.name}" if symbol.receiver_type else symbol.name
    node_id = f"{parent_id}::{name_part}"

    # Deduplication guard
    if emitted_ids is not None:
        if node_id in emitted_ids:
            return nodes, rels, sym_infos, call_infos, classes, functions
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

        # DEFINED_IN: class is defined in the file (file → class direction)
        rels.append(
            GraphRelationship(
                id=f"{node_id}->DEFINED_IN->{parent_id}",
                type="DEFINED_IN",
                source_id=node_id,
                target_id=parent_id,
                properties={},
            )
        )

        # Process child methods
        for child_sym in symbol.children:
            child_nodes, child_rels, child_sis, child_calls, c, f = _symbol_to_graph(
                child_sym, node_id, language, emitted_ids
            )
            nodes.extend(child_nodes)
            rels.extend(child_rels)
            call_infos.extend(child_calls)
            classes += c
            functions += f
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
        if symbol.docs:
            props["docs"] = symbol.docs
        nodes.append(GraphNode(id=node_id, type="Function", name=symbol.name, properties=props))
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

        # DEFINED_IN relationship
        rels.append(
            GraphRelationship(
                id=f"{node_id}->DEFINED_IN->{parent_id}",
                type="DEFINED_IN",
                source_id=node_id,
                target_id=parent_id,
                properties={},
            )
        )

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

    return nodes, rels, sym_infos, call_infos, classes, functions


def _register_symbol(si: SymbolInfo, registries: Registries) -> None:
    """Add a SymbolInfo to all relevant registries."""
    registries.name_registry.setdefault(si.name, []).append(si)
    registries.file_registry.setdefault(si.file_id, {})[si.name] = si
    if si.kind == "class":
        registries.class_registry.setdefault(si.name, []).append(si)
