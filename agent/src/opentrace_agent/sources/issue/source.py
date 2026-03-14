"""Issue source definition."""

from opentrace_agent.sources.base import Source


class IssueSource(Source):
    """Source for issue/ticket data (issues, comments, users)."""

    @property
    def source_type(self) -> str:
        return "issue"
