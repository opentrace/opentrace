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

"""Stage 3: Resolving — 7-strategy call resolution producing CALLS relationships."""

from __future__ import annotations

import logging
from typing import Generator

from opentrace_agent.pipeline.types import (
    CallInfo,
    DerivationInfo,
    EventKind,
    GraphRelationship,
    Phase,
    PipelineContext,
    PipelineEvent,
    PipelineResult,
    ProcessingOutput,
    ProgressDetail,
    Registries,
    StageResult,
)

logger = logging.getLogger(__name__)


def resolving(
    proc: ProcessingOutput,
    ctx: PipelineContext,
    out: StageResult[PipelineResult],
) -> Generator[PipelineEvent, None, None]:
    """Resolve call references and derivations using registries."""
    total = len(proc.call_infos) + len(proc.derivation_infos)
    yield PipelineEvent(
        kind=EventKind.STAGE_START,
        phase=Phase.RESOLVING,
        message=f"Resolving calls from {len(proc.call_infos)} callers, {len(proc.derivation_infos)} derivations",
        detail=ProgressDetail(current=0, total=total),
    )

    if ctx.cancelled:
        return

    resolved_rels = resolve_calls(proc.call_infos, proc.registries)
    calls_count = len(resolved_rels)

    if resolved_rels:
        yield PipelineEvent(
            kind=EventKind.STAGE_PROGRESS,
            phase=Phase.RESOLVING,
            message=f"Resolved {calls_count} call relationships",
            detail=ProgressDetail(current=calls_count, total=total),
            relationships=resolved_rels,
        )

    # Resolve derivations
    derivation_rels = resolve_derivations(proc.derivation_infos, proc.registries)
    derivations_count = len(derivation_rels)

    if derivation_rels:
        yield PipelineEvent(
            kind=EventKind.STAGE_PROGRESS,
            phase=Phase.RESOLVING,
            message=f"Resolved {derivations_count} derivation relationships",
            detail=ProgressDetail(current=calls_count + derivations_count, total=total),
            relationships=derivation_rels,
        )

    yield PipelineEvent(
        kind=EventKind.STAGE_STOP,
        phase=Phase.RESOLVING,
        message=f"Resolved {calls_count} calls, {derivations_count} derivations",
    )

    out.value = PipelineResult(
        nodes_created=proc.nodes_created,
        relationships_created=proc.relationships_created + calls_count + derivations_count,
        files_processed=proc.files_processed,
        classes_extracted=proc.classes_extracted,
        functions_extracted=proc.functions_extracted,
        variables_extracted=proc.variables_extracted,
        derivations_resolved=derivations_count,
        errors=proc.errors,
    )


def resolve_calls(
    call_infos: list[CallInfo],
    registries: Registries,
) -> list[GraphRelationship]:
    """Apply the 7-strategy resolution chain to all call references.

    Returns a list of CALLS GraphRelationship objects.
    """
    results: list[GraphRelationship] = []

    for ci in call_infos:
        seen: set[str] = set()
        for name, receiver, kind in ci.calls:
            dedup_key = f"{receiver or ''}:{name}"
            if dedup_key in seen:
                continue
            if name == ci.caller_name and receiver is None:
                continue

            target_id, confidence = _resolve_single_call(
                name=name,
                receiver=receiver,
                kind=kind,
                caller_id=ci.caller_id,
                file_id=ci.file_id,
                caller_receiver_var=ci.receiver_var,
                caller_receiver_type=ci.receiver_type,
                caller_param_types=ci.param_types,
                registries=registries,
            )
            if target_id is None:
                continue

            seen.add(dedup_key)
            results.append(
                GraphRelationship(
                    id=f"{ci.caller_id}->CALLS->{target_id}",
                    type="CALLS",
                    source_id=ci.caller_id,
                    target_id=target_id,
                    properties={"confidence": confidence},
                )
            )

    return results


def _resolve_single_call(
    *,
    name: str,
    receiver: str | None,
    kind: str,
    caller_id: str,
    file_id: str,
    caller_receiver_var: str | None,
    caller_receiver_type: str | None,
    caller_param_types: dict[str, str] | None,
    registries: Registries,
) -> tuple[str | None, float]:
    """Try to resolve a single call reference. Returns (target_node_id, confidence)."""

    # Strategy 1: self/this → enclosing class children
    if kind == "attribute" and receiver in ("self", "this"):
        # The caller's parent in the ID is the class: file_id::ClassName::method
        parts = caller_id.rsplit("::", 2)
        if len(parts) >= 3:
            class_name = parts[-2]
            class_candidates = registries.class_registry.get(class_name, [])
            for cls in class_candidates:
                if cls.file_id == file_id:
                    for child in cls.children:
                        if child.name == name:
                            return child.node_id, 1.0
        return None, 0.0

    # Strategy 2: Go receiver variable resolution
    if kind == "attribute":
        if caller_receiver_var and receiver == caller_receiver_var and caller_receiver_type:
            candidates = registries.name_registry.get(name, [])
            for c in candidates:
                if c.receiver_type == caller_receiver_type:
                    return c.node_id, 1.0

    # Strategy 2.5: Parameter type hint resolution
    if kind == "attribute" and receiver:
        if caller_param_types:
            type_name = caller_param_types.get(receiver)
            if type_name and type_name in registries.class_registry:
                for cls in registries.class_registry[type_name]:
                    for child in cls.children:
                        if child.name == name:
                            return child.node_id, 0.7

    # Strategy 3: ClassName.method() resolution
    if kind == "attribute" and receiver in registries.class_registry:
        class_candidates = registries.class_registry[receiver]
        sorted_classes = sorted(class_candidates, key=lambda c: 0 if c.file_id == file_id else 1)
        for cls in sorted_classes:
            for child in cls.children:
                if child.name == name:
                    conf = 1.0 if child.file_id == file_id else 0.9
                    return child.node_id, conf
        # Go-style methods with matching receiver_type
        candidates = registries.name_registry.get(name, [])
        for c in candidates:
            if c.receiver_type == receiver:
                conf = 1.0 if c.file_id == file_id else 0.9
                return c.node_id, conf
        return None, 0.0

    # Strategy 4: Import-based resolution — receiver matches an import alias
    if kind == "attribute":
        file_imports = registries.import_registry.get(file_id, {})
        target_file_id = file_imports.get(receiver or "")
        if target_file_id:
            target_names = registries.file_registry.get(target_file_id, {})
            target = target_names.get(name)
            if target is not None:
                return target.node_id, 0.9

    # Strategy 4.5: Import-based bare call (from X import Y → Y())
    if kind == "bare":
        file_imports = registries.import_registry.get(file_id, {})
        target_file_id = file_imports.get(name)
        if target_file_id:
            target_names = registries.file_registry.get(target_file_id, {})
            target = target_names.get(name)
            if target is not None:
                # If it's a class, prefer its __init__/constructor
                if target.kind == "class":
                    for child in target.children:
                        if child.name in ("__init__", "constructor"):
                            return child.node_id, 0.9
                return target.node_id, 0.9

    # Strategy 5: Constructor call — bare name matches a class
    if kind == "bare" and name in registries.class_registry:
        class_candidates = registries.class_registry[name]
        sorted_classes = sorted(class_candidates, key=lambda c: 0 if c.file_id == file_id else 1)
        for cls in sorted_classes:
            for child in cls.children:
                if child.name in ("__init__", "constructor"):
                    conf = 1.0 if child.file_id == file_id else 0.8
                    return child.node_id, conf
        # Fall back to the class node itself
        cls = sorted_classes[0]
        conf = 1.0 if cls.file_id == file_id else 0.8
        return cls.node_id, conf

    # Strategy 6: Intra-file bare call
    if kind == "bare":
        file_names = registries.file_registry.get(file_id, {})
        target = file_names.get(name)
        if target is not None:
            return target.node_id, 1.0

    # Strategy 7: Cross-file bare call (unique match only)
    if kind == "bare":
        candidates = registries.name_registry.get(name, [])
        cross_file = [c for c in candidates if c.file_id != file_id]
        if len(cross_file) == 1:
            return cross_file[0].node_id, 0.8

    return None, 0.0


def resolve_derivations(
    derivation_infos: list[DerivationInfo],
    registries: Registries,
) -> list[GraphRelationship]:
    """Resolve derivation references into DERIVED_FROM relationships.

    For each derivation ref:
    - identifier → scope-chain variable lookup
    - call → name_registry / file_registry function lookup
    - attribute → scope-chain for self.field (skip local scope), import-based otherwise
    """
    results: list[GraphRelationship] = []

    for di in derivation_infos:
        for name, receiver, kind in di.refs:
            target_id: str | None = None
            transform = kind

            if kind == "identifier":
                target_id = _find_variable_in_scopes(name, di.scope_id, registries.variable_registry)
                # Fallback: imported symbol (e.g., from other import CONSTANT)
                if target_id is None:
                    file_imports = registries.import_registry.get(di.file_id, {})
                    target_file_id = file_imports.get(name)
                    if target_file_id:
                        target_sym = registries.file_registry.get(target_file_id, {}).get(name)
                        if target_sym:
                            target_id = target_sym.node_id

            elif kind == "call":
                if receiver:
                    # Attribute call: receiver.name() — try import-based
                    file_imports = registries.import_registry.get(di.file_id, {})
                    target_file_id = file_imports.get(receiver)
                    if target_file_id:
                        target_names = registries.file_registry.get(target_file_id, {})
                        target_sym = target_names.get(name)
                        if target_sym:
                            target_id = target_sym.node_id
                else:
                    # Bare call: name() — try file_registry, import_registry, then name_registry
                    file_names = registries.file_registry.get(di.file_id, {})
                    target_sym = file_names.get(name)
                    if target_sym:
                        target_id = target_sym.node_id
                    if target_id is None:
                        # Import-based: from X import func → func()
                        file_imports = registries.import_registry.get(di.file_id, {})
                        target_file_id = file_imports.get(name)
                        if target_file_id:
                            target_sym = registries.file_registry.get(target_file_id, {}).get(name)
                            if target_sym:
                                target_id = target_sym.node_id
                    if target_id is None:
                        candidates = registries.name_registry.get(name, [])
                        if len(candidates) == 1:
                            target_id = candidates[0].node_id

            elif kind == "attribute":
                if receiver in ("self", "this"):
                    # self.field — skip local scope, start from parent (class) scope
                    parent_scope = "::".join(di.scope_id.rsplit("::", 1)[:-1]) if "::" in di.scope_id else None
                    if parent_scope:
                        target_id = _find_variable_in_scopes(name, parent_scope, registries.variable_registry)
                else:
                    # module.attr — try import-based
                    file_imports = registries.import_registry.get(di.file_id, {})
                    target_file_id = file_imports.get(receiver or "")
                    if target_file_id:
                        target_names = registries.file_registry.get(target_file_id, {})
                        target_sym = target_names.get(name)
                        if target_sym:
                            target_id = target_sym.node_id

            if target_id:
                results.append(
                    GraphRelationship(
                        id=f"{di.variable_id}->DERIVED_FROM->{target_id}",
                        type="DERIVED_FROM",
                        source_id=di.variable_id,
                        target_id=target_id,
                        properties={"transform": transform},
                    )
                )

    return results


def _find_variable_in_scopes(
    name: str,
    scope_id: str,
    variable_registry: dict[str, dict[str, str]],
) -> str | None:
    """Walk up the scope chain looking for a variable by name.

    Scope chain is derived from the ``::``-separated node ID:
    ``file::Class::method`` → try method scope, then Class scope, then file scope.
    """
    current = scope_id
    while current:
        scope_vars = variable_registry.get(current, {})
        if name in scope_vars:
            return scope_vars[name]
        if "::" in current:
            current = current.rsplit("::", 1)[0]
        else:
            break
    return None
