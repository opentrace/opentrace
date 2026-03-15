"""Source and Loader abstractions for data collection."""

from opentrace_agent.sources.base import Loader, Source
from opentrace_agent.sources.registry import SourceRegistry

__all__ = ["Loader", "Source", "SourceRegistry"]
