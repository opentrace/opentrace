"""Tests for opentrace_agent.sources.issue.source."""

import pytest

from opentrace_agent.sources.issue.gitlab_loader import GitLabIssueLoader
from opentrace_agent.sources.issue.linear_loader import LinearIssueLoader
from opentrace_agent.sources.issue.source import IssueSource


class TestIssueSource:
    def test_source_type(self):
        assert IssueSource().source_type == "issue"

    @pytest.mark.anyio
    async def test_collect_multiple_loaders(self):
        source = IssueSource()
        source.register_loader(GitLabIssueLoader())
        source.register_loader(LinearIssueLoader())

        trees = await source.collect(
            {
                "gitlab": {"projects": [{"id": "g/p", "name": "G"}]},
                "linear": {"teams": [{"key": "L", "name": "Lin"}]},
            }
        )
        assert len(trees) == 2
