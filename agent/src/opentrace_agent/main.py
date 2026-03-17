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

"""OpenTrace Agent entrypoint."""

from __future__ import annotations

import argparse
import asyncio
import logging

from opentrace_agent.config import AgentConfig, load_config, load_sources_config
from opentrace_agent.container import AppContainer
from opentrace_agent.sources.registry import SourceRegistry

logger = logging.getLogger(__name__)


def build_registry() -> SourceRegistry:
    """Wire up all sources and their loaders.

    .. deprecated::
        Use ``AppContainer.source_registry()`` instead.
    """
    container = AppContainer(config=AgentConfig())
    return container.source_registry()


async def run(config: AgentConfig) -> None:
    """Async entry point: build graph and invoke the pipeline."""
    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    logger.info("OpenTrace agent starting")

    sources_config = load_sources_config(config.sources_config_path)
    if not sources_config:
        logger.info("No sources configured — nothing to do")
        return

    container = AppContainer(config=config)
    registry = container.source_registry()

    # Only create MCP client and mapper if we have an MCP URL
    if not config.opentrace_mcp_url:
        logger.info("No MCP URL configured — running in dry-run mode (load only)")
        # Run loaders without mapping to verify they work
        for source_type, source in registry.all_sources.items():
            source_cfg = sources_config.get(source_type, {})
            if source_cfg:
                trees = await source.collect(source_cfg)
                logger.info(
                    "Source '%s' produced %d tree(s) (dry-run, not mapped)",
                    source_type,
                    len(trees),
                )
        return

    from opentrace_agent.agent.graph import build_agent_graph

    headers = {}
    if config.opentrace_api_key:
        headers["Authorization"] = f"Bearer {config.opentrace_api_key}"

    mcp_client = container.mcp_client(
        url=config.opentrace_mcp_url,
        headers=headers if headers else None,
    )

    try:
        mapper = container.graph_mapper(mcp=mcp_client)
        agent = build_agent_graph(registry, mapper)

        result = await agent.ainvoke({"sources_config": sources_config})

        mapping_result = result.get("mapping_result")
        errors = result.get("errors", [])

        if mapping_result:
            logger.info(
                "Agent complete: %d nodes, %d relationships created",
                mapping_result.nodes_created,
                mapping_result.relationships_created,
            )
        if errors:
            logger.warning("Agent completed with %d error(s):", len(errors))
            for err in errors:
                logger.warning("  - %s", err)
    finally:
        await mcp_client.close()


def main() -> None:
    """Synchronous entry point for the CLI."""
    parser = argparse.ArgumentParser(description="OpenTrace Agent CLI")
    parser.add_argument(
        "--config",
        default="",
        metavar="PATH",
        help="Path to config.yaml (shared with the Go API)",
    )
    args = parser.parse_args()

    config = load_config(args.config)
    asyncio.run(run(config))


if __name__ == "__main__":
    main()
