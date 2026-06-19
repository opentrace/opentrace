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

"""Tests for pyproject.toml dependency parsing."""

from __future__ import annotations

from opentrace_agent.sources.code.manifest_parser import parse_pyproject_toml


def _names(toml: str) -> list[str]:
    return [d.name for d in parse_pyproject_toml(toml, "pyproject.toml")]


class TestPyprojectDependencies:
    def test_multiline_array(self):
        toml = '[project]\ndependencies = [\n  "requests>=2.0",\n  "click<9",\n  "rich",\n]\n'
        assert _names(toml) == ["requests", "click", "rich"]

    def test_inline_array(self):
        assert _names('[project]\ndependencies = ["flask>=3"]\n') == ["flask"]

    def test_no_dependencies(self):
        assert _names('[project]\nname = "x"\n') == []

    def test_multiline_with_extras_mid_array(self):
        # A bracket inside a quoted extras marker must not close the array early.
        toml = '[project]\ndependencies = [\n  "requests[security]>=2.0",\n  "click<9",\n  "rich",\n]\n'
        assert _names(toml) == ["requests", "click", "rich"]

    def test_inline_with_extras(self):
        toml = '[project]\ndependencies = ["requests[security]>=2.0", "click"]\n'
        assert _names(toml) == ["requests", "click"]

    def test_extras_on_opening_line(self):
        toml = '[project]\ndependencies = ["requests[security]>=1",\n  "click",\n]\n'
        assert _names(toml) == ["requests", "click"]

    def test_multiline_single_quoted(self):
        # TOML allows single-quoted strings; multi-line continuation lines
        # must capture them too, not just double-quoted entries.
        toml = "[project]\ndependencies = [\n  'requests>=2.0',\n  'click<9',\n]\n"
        assert _names(toml) == ["requests", "click"]
