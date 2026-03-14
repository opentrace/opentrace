"""Registry for managing available sources."""

from __future__ import annotations

import logging

from opentrace_agent.sources.base import Source

logger = logging.getLogger(__name__)


class SourceRegistry:
    """Central registry mapping source_type -> Source instance."""

    def __init__(self) -> None:
        self._sources: dict[str, Source] = {}

    def register(self, source: Source) -> None:
        self._sources[source.source_type] = source
        logger.debug("Registered source '%s'", source.source_type)

    def get(self, source_type: str) -> Source | None:
        return self._sources.get(source_type)

    @property
    def all_sources(self) -> dict[str, Source]:
        return dict(self._sources)
