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

"""Tests for pyproject.toml and go.mod dependency parsing."""

from __future__ import annotations

from opentrace_agent.sources.code.manifest_parser import parse_go_mod, parse_pyproject_toml


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


class TestGoModDependencies:
    def test_single_line_require(self):
        content = "module example.com/app\n\nrequire github.com/stretchr/testify v1.9.0\n"
        deps = parse_go_mod(content, "go.mod")
        assert [(d.name, d.version) for d in deps] == [("github.com/stretchr/testify", "v1.9.0")]

    def test_block_require_with_slashed_paths(self):
        # Go module paths contain slashes; the block parser must not drop them.
        content = (
            "module example.com/app\n"
            "\n"
            "require (\n"
            "\tgithub.com/stretchr/testify v1.9.0\n"
            "\tgolang.org/x/sync v0.7.0 // indirect\n"
            ")\n"
        )
        deps = parse_go_mod(content, "go.mod")
        assert [(d.name, d.version, d.dependency_type) for d in deps] == [
            ("github.com/stretchr/testify", "v1.9.0", "runtime"),
            ("golang.org/x/sync", "v0.7.0", "indirect"),
        ]

    def test_block_require_skips_comment_lines(self):
        content = "require (\n\t// direct deps below\n\tgithub.com/spf13/cobra v1.8.0\n)\n"
        deps = parse_go_mod(content, "go.mod")
        assert [(d.name, d.version) for d in deps] == [("github.com/spf13/cobra", "v1.8.0")]
