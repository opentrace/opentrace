"""Agent state definition for the LangGraph pipeline."""

from __future__ import annotations

from typing import Any, TypedDict

from opentrace_agent.graph.mapper import MappingResult
from opentrace_agent.models.base import TreeWithOrigin


class AgentState(TypedDict, total=False):
    """State flowing through the plan → load → map pipeline."""

    # Input
    sources_config: dict[str, Any]
    """Per-source-type config, e.g. {"code": {"github": {...}}, "issue": {"linear": {...}}}."""

    # Plan output
    sources_to_run: list[str]
    """Source types that have matching loader configs (e.g. ["code", "issue"])."""

    # Load output
    trees: list[TreeWithOrigin]
    """Aggregated trees from all loaders."""

    # Map output
    mapping_result: MappingResult | None
    """Summary of the graph mapping operation."""

    # Errors accumulated across all phases
    errors: list[str]
