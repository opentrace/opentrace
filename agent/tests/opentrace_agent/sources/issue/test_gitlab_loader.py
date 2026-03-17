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
        trees = await loader.load({"projects": [{"id": "group/proj", "name": "My Proj"}]})
        assert len(trees) == 1
        assert trees[0].origin == "issue"
        assert trees[0].root.name == "My Proj"
