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

"""Tests for opentrace_agent.sources.registry."""

from opentrace_agent.sources.code.source import CodeSource
from opentrace_agent.sources.issue.source import IssueSource
from opentrace_agent.sources.registry import SourceRegistry


class TestSourceRegistry:
    def test_register_and_get(self):
        registry = SourceRegistry()
        source = CodeSource()
        registry.register(source)

        assert registry.get("code") is source
        assert registry.get("nonexistent") is None

    def test_all_sources(self):
        registry = SourceRegistry()
        registry.register(CodeSource())
        registry.register(IssueSource())
        assert set(registry.all_sources.keys()) == {"code", "issue"}
