"""LangGraph StateGraph: plan → load → map pipeline."""

from __future__ import annotations

import logging
from typing import Any

from langgraph.graph import END, StateGraph

from opentrace_agent.agent.state import AgentState
from opentrace_agent.graph.mapper import GraphMapper
from opentrace_agent.sources.registry import SourceRegistry

logger = logging.getLogger(__name__)


def _make_plan_node(registry: SourceRegistry):
    """Create the plan node function (determines which sources to run)."""

    def plan_node(state: AgentState) -> dict[str, Any]:
        sources_config = state.get("sources_config", {})
        sources_to_run: list[str] = []

        for source_type, source in registry.all_sources.items():
            source_cfg = sources_config.get(source_type, {})
            # Check if any registered loader has config
            has_config = any(loader.provider_name in source_cfg for loader in source.loaders)
            if has_config:
                sources_to_run.append(source_type)
                logger.info("Source '%s' has configured loaders, will run", source_type)
            else:
                logger.debug("Source '%s' has no configured loaders, skipping", source_type)

        if not sources_to_run:
            logger.info("No sources configured — nothing to do")

        return {"sources_to_run": sources_to_run, "errors": []}

    return plan_node


def _make_load_node(registry: SourceRegistry):
    """Create the load node function (runs loaders and collects trees)."""

    async def load_node(state: AgentState) -> dict[str, Any]:
        from opentrace_agent.models.base import TreeWithOrigin

        sources_to_run = state.get("sources_to_run", [])
        sources_config = state.get("sources_config", {})
        all_trees: list[TreeWithOrigin] = []
        errors: list[str] = list(state.get("errors", []))

        for source_type in sources_to_run:
            source = registry.get(source_type)
            if not source:
                errors.append(f"Source '{source_type}' not found in registry")
                continue

            source_cfg = sources_config.get(source_type, {})
            try:
                trees = await source.collect(source_cfg)
                all_trees.extend(trees)
                logger.info("Source '%s' produced %d tree(s)", source_type, len(trees))
            except Exception as e:
                msg = f"Error loading source '{source_type}': {e}"
                logger.error(msg)
                errors.append(msg)

        return {"trees": all_trees, "errors": errors}

    return load_node


def _make_map_node(mapper: GraphMapper):
    """Create the map node function (pushes trees to Neo4j via MCP)."""

    async def map_node(state: AgentState) -> dict[str, Any]:
        trees = state.get("trees", [])
        errors = list(state.get("errors", []))

        if not trees:
            logger.info("No trees to map")
            return {"mapping_result": None, "errors": errors}

        try:
            result = await mapper.map_trees(trees)
            errors.extend(result.errors)
            return {"mapping_result": result, "errors": errors}
        except Exception as e:
            msg = f"Error during graph mapping: {e}"
            logger.error(msg)
            errors.append(msg)
            return {"mapping_result": None, "errors": errors}

    return map_node


def build_agent_graph(
    registry: SourceRegistry,
    mapper: GraphMapper,
) -> StateGraph:
    """Build the plan → load → map LangGraph pipeline.

    Returns a compiled StateGraph ready to invoke.
    """
    graph = StateGraph(AgentState)

    graph.add_node("plan", _make_plan_node(registry))
    graph.add_node("load", _make_load_node(registry))
    graph.add_node("map", _make_map_node(mapper))

    graph.set_entry_point("plan")
    graph.add_edge("plan", "load")
    graph.add_edge("load", "map")
    graph.add_edge("map", END)

    return graph.compile()
