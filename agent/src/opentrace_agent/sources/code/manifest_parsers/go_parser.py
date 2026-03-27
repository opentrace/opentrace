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

"""Parser for go.mod manifest files."""

from __future__ import annotations

import re

from opentrace_agent.sources.code.manifest_parsers.types import ParsedDependency

_GO_REQUIRE_SINGLE = re.compile(
    r'^\s*require\s+"?([^\s"]+)"?\s+(\S+)',
)
_GO_REQUIRE_BLOCK_LINE = re.compile(
    r"^\s*([^\s/]+)\s+(\S+)",
)


def parse_go_mod(content: str, source: str) -> list[ParsedDependency]:
    deps: list[ParsedDependency] = []
    in_require = False

    for line in content.splitlines():
        stripped = line.strip()

        # Extract module path
        if stripped.startswith("module "):
            continue

        # Single-line require
        m = _GO_REQUIRE_SINGLE.match(stripped)
        if m:
            deps.append(
                ParsedDependency(
                    name=m.group(1),
                    version=m.group(2),
                    registry="go",
                    source=source,
                    dependency_type="runtime",
                )
            )
            continue

        # Block require
        if stripped.startswith("require (") or stripped == "require (":
            in_require = True
            continue
        if in_require:
            if stripped == ")":
                in_require = False
                continue
            m = _GO_REQUIRE_BLOCK_LINE.match(stripped)
            if m:
                dep_type = "indirect" if "// indirect" in line else "runtime"
                deps.append(
                    ParsedDependency(
                        name=m.group(1),
                        version=m.group(2),
                        registry="go",
                        source=source,
                        dependency_type=dep_type,
                    )
                )

    return deps


def extract_go_module_path(content: str) -> str | None:
    """Extract the module path from go.mod content."""
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("module "):
            return stripped.split(None, 1)[1].strip()
    return None
