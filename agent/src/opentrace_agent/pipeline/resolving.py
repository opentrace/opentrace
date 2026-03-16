"""Stage 3: Resolving — 7-strategy call resolution producing CALLS relationships."""

from __future__ import annotations

import logging
from typing import Generator

from opentrace_agent.pipeline.types import (
    CallInfo,
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
    """Resolve call references using registries and emit CALLS relationships."""
    total = len(proc.call_infos)
    yield PipelineEvent(
        kind=EventKind.STAGE_START,
        phase=Phase.RESOLVING,
        message=f"Resolving calls from {total} callers",
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
            detail=ProgressDetail(current=calls_count, total=calls_count),
            relationships=resolved_rels,
        )

    yield PipelineEvent(
        kind=EventKind.STAGE_STOP,
        phase=Phase.RESOLVING,
        message=f"Resolved {calls_count} calls",
    )

    out.value = PipelineResult(
        nodes_created=proc.nodes_created,
        relationships_created=proc.relationships_created + calls_count,
        files_processed=proc.files_processed,
        classes_extracted=proc.classes_extracted,
        functions_extracted=proc.functions_extracted,
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
