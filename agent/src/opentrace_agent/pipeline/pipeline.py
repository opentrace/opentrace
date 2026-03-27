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

"""Pipeline composition — connects scanning → processing → resolving → saving."""

from __future__ import annotations

from typing import Generator

from opentrace_agent.pipeline.processing import processing as _default_processing
from opentrace_agent.pipeline.resolving import resolving as _default_resolving
from opentrace_agent.pipeline.saving import saving
from opentrace_agent.pipeline.scanning import scanning as _default_scanning
from opentrace_agent.pipeline.store import Store
from opentrace_agent.pipeline.summarizing import summarizing as _default_summarizing
from opentrace_agent.pipeline.types import (
    EventKind,
    GraphNode,
    GraphRelationship,
    Phase,
    PipelineContext,
    PipelineEvent,
    PipelineInput,
    PipelineResult,
    PipelineStages,
    ProcessingOutput,
    ScanResult,
    StageResult,
)


def core_pipeline(
    inp: PipelineInput,
    ctx: PipelineContext,
    stages: PipelineStages | None = None,
) -> Generator[PipelineEvent, None, None]:
    """Run scanning → processing → resolving, yielding events throughout."""
    _scanning = (stages and stages.scanning) or _default_scanning
    _processing = (stages and stages.processing) or _default_processing
    _resolving = (stages and stages.resolving) or _default_resolving

    scan_out: StageResult[ScanResult] = StageResult()
    yield from _scanning(inp, ctx, scan_out)
    if ctx.cancelled or scan_out.value is None:
        return

    proc_out: StageResult[ProcessingOutput] = StageResult()
    yield from _processing(scan_out.value, ctx, proc_out)
    if ctx.cancelled or proc_out.value is None:
        return

    result_out: StageResult[PipelineResult] = StageResult()
    yield from _resolving(proc_out.value, ctx, result_out)

    yield PipelineEvent(
        kind=EventKind.DONE,
        phase=Phase.RESOLVING,
        message="Pipeline complete",
        result=result_out.value,
    )


def run_pipeline(
    inp: PipelineInput,
    ctx: PipelineContext | None = None,
    store: Store | None = None,
    stages: PipelineStages | None = None,
) -> Generator[PipelineEvent, None, None]:
    """Public entry point — run the full pipeline, optionally persisting via store.

    Parameters
    ----------
    stages:
        Optional :class:`PipelineStages` to override individual stages.
        Any stage left as ``None`` falls back to the built-in implementation.
    """
    ctx = ctx or PipelineContext()
    _summarizing = (stages and stages.summarizing) or _default_summarizing
    inner = _summarizing(core_pipeline(inp, ctx, stages))
    if store is not None:
        yield from saving(inner, store)
    else:
        yield from inner


def collect_pipeline(
    inp: PipelineInput,
    ctx: PipelineContext | None = None,
    store: Store | None = None,
    stages: PipelineStages | None = None,
) -> tuple[list[PipelineEvent], list[GraphNode], list[GraphRelationship]]:
    """Convenience for tests — consume all events, return aggregated results."""
    events: list[PipelineEvent] = []
    all_nodes: list[GraphNode] = []
    all_rels: list[GraphRelationship] = []

    for event in run_pipeline(inp, ctx, store, stages):
        events.append(event)
        if event.nodes:
            all_nodes.extend(event.nodes)
        if event.relationships:
            all_rels.extend(event.relationships)

    return events, all_nodes, all_rels
