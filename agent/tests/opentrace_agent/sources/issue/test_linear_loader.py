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
