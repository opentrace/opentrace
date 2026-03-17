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
