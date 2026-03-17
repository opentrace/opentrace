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

from opentrace_agent.pipeline.processing import processing
from opentrace_agent.pipeline.resolving import resolving
from opentrace_agent.pipeline.saving import saving
from opentrace_agent.pipeline.scanning import scanning
from opentrace_agent.pipeline.store import Store
from opentrace_agent.pipeline.types import (
    EventKind,
    GraphNode,
    GraphRelationship,
    Phase,
    PipelineContext,
    PipelineEvent,
    PipelineInput,
    PipelineResult,
    ProcessingOutput,
    ScanResult,
    StageResult,
)


def core_pipeline(
    inp: PipelineInput,
    ctx: PipelineContext,
) -> Generator[PipelineEvent, None, None]:
    """Run scanning → processing → resolving, yielding events throughout."""
    scan_out: StageResult[ScanResult] = StageResult()
    yield from scanning(inp, ctx, scan_out)
    if ctx.cancelled or scan_out.value is None:
        return

    proc_out: StageResult[ProcessingOutput] = StageResult()
    yield from processing(scan_out.value, ctx, proc_out)
    if ctx.cancelled or proc_out.value is None:
        return

    result_out: StageResult[PipelineResult] = StageResult()
    yield from resolving(proc_out.value, ctx, result_out)

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
) -> Generator[PipelineEvent, None, None]:
    """Public entry point — run the full pipeline, optionally persisting via store."""
    ctx = ctx or PipelineContext()
    inner = core_pipeline(inp, ctx)
    if store is not None:
        yield from saving(inner, store)
    else:
        yield from inner


def collect_pipeline(
    inp: PipelineInput,
    ctx: PipelineContext | None = None,
    store: Store | None = None,
) -> tuple[list[PipelineEvent], list[GraphNode], list[GraphRelationship]]:
    """Convenience for tests — consume all events, return aggregated results."""
    events: list[PipelineEvent] = []
    all_nodes: list[GraphNode] = []
    all_rels: list[GraphRelationship] = []

    for event in run_pipeline(inp, ctx, store):
        events.append(event)
        if event.nodes:
            all_nodes.extend(event.nodes)
        if event.relationships:
            all_rels.extend(event.relationships)

    return events, all_nodes, all_rels
