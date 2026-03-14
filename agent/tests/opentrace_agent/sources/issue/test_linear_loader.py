"""Tests for opentrace_agent.sources.issue.linear_loader."""

import pytest

from opentrace_agent.sources.issue.linear_loader import LinearIssueLoader


class TestLinearIssueLoader:
    def test_provider_name(self):
        assert LinearIssueLoader().provider_name == "linear"

    @pytest.mark.anyio
    async def test_load_no_teams(self):
        loader = LinearIssueLoader()
        trees = await loader.load({})
        assert trees == []

    @pytest.mark.anyio
    async def test_load_with_team(self):
        loader = LinearIssueLoader()
        trees = await loader.load({"teams": [{"key": "ENG", "name": "Engineering"}]})
        assert len(trees) == 1
        assert trees[0].origin == "issue"
        assert trees[0].root.name == "Engineering"
