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

"""Summarization stage: wraps an inner event stream and ensures every
node that flows through has a ``summary`` property.

Runs after all other stages, intercepting every event.  For each node
without a summary, calls the template summarizer.  Nodes that already
have a summary (e.g. from doc comments) are left unchanged.
"""

from __future__ import annotations

from typing import Generator

from opentrace_agent.pipeline.types import (
    EventKind,
    GraphNode,
    Phase,
    PipelineEvent,
    ProgressDetail,
)
from opentrace_agent.sources.code.summarizer import SymbolMetadata, summarize_from_metadata

_TYPE_TO_KIND: dict[str, str] = {
    "Function": "function",
    "Class": "class",
    "File": "file",
    "Directory": "directory",
}


def _summarize_node(node: GraphNode) -> str:
    """Build a SymbolMetadata from a graph node and generate a summary."""
    kind = _TYPE_TO_KIND.get(node.type)
    if not kind:
        return f"{node.type} {node.name}"

    props = node.properties or {}
    return summarize_from_metadata(
        SymbolMetadata(
            name=node.name,
            kind=kind,
            signature=props.get("signature"),  # type: ignore[arg-type]
            language=props.get("language"),  # type: ignore[arg-type]
            line_count=(
                props["end_line"] - props["start_line"] + 1
                if isinstance(props.get("start_line"), int) and isinstance(props.get("end_line"), int)
                else None
            ),
            receiver_type=props.get("receiver_type"),  # type: ignore[arg-type]
            file_name=props.get("path", node.name) if kind == "file" else None,  # type: ignore[arg-type]
            child_names=props.get("childNames"),  # type: ignore[arg-type]
            docs=props.get("docs"),  # type: ignore[arg-type]
        )
    )


def summarizing(
    inner: Generator[PipelineEvent, None, None],
) -> Generator[PipelineEvent, None, None]:
    """Wrap an inner event generator, adding summaries to every node."""
    summarized = 0
    total = 0

    yield PipelineEvent(
        kind=EventKind.STAGE_START,
        phase=Phase.SUMMARIZING,
        message="Summarizing nodes...",
    )

    for event in inner:
        if event.nodes:
            for node in event.nodes:
                total += 1
                if not (node.properties or {}).get("summary"):
                    summary = _summarize_node(node)
                    if summary:
                        # GraphNode is frozen, so create a new one with merged props
                        new_props = {**(node.properties or {}), "summary": summary}
                        # Replace in the list in-place by index
                        idx = event.nodes.index(node)
                        event.nodes[idx] = GraphNode(
                            id=node.id,
                            type=node.type,
                            name=node.name,
                            properties=new_props,
                        )
                        summarized += 1

            yield PipelineEvent(
                kind=EventKind.STAGE_PROGRESS,
                phase=Phase.SUMMARIZING,
                message=f"Summarized {summarized} of {total} nodes",
                detail=ProgressDetail(current=summarized, total=total),
            )
        yield event

    yield PipelineEvent(
        kind=EventKind.STAGE_STOP,
        phase=Phase.SUMMARIZING,
        message=f"Summarized {summarized} nodes",
    )
