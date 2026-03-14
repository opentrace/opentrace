"""Code source definition."""

from opentrace_agent.sources.base import Source


class CodeSource(Source):
    """Source for code repository data (files, classes, functions)."""

    @property
    def source_type(self) -> str:
        return "code"
