"""Tests for opentrace_agent.sources.issue.gitlab_loader."""

import pytest

from opentrace_agent.sources.issue.gitlab_loader import GitLabIssueLoader


class TestGitLabIssueLoader:
    def test_provider_name(self):
        assert GitLabIssueLoader().provider_name == "gitlab"

    @pytest.mark.anyio
    async def test_load_no_projects(self):
        loader = GitLabIssueLoader()
        trees = await loader.load({})
        assert trees == []

    @pytest.mark.anyio
    async def test_load_with_project(self):
        loader = GitLabIssueLoader()
        trees = await loader.load(
            {"projects": [{"id": "group/proj", "name": "My Proj"}]}
        )
        assert len(trees) == 1
        assert trees[0].origin == "issue"
        assert trees[0].root.name == "My Proj"
