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

"""Parser for requirements.txt manifest files."""

from __future__ import annotations

import re

from opentrace_agent.sources.code.manifest_parsers.types import ParsedDependency

_REQ_LINE = re.compile(
    r"^([A-Za-z0-9_.-]+)(?:\[.*?\])?\s*([<>=!~]+\s*\S+)?",
)


def normalize_py_name(name: str) -> str:
    """Normalize a Python package name: lowercase, underscores -> dashes."""
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_requirements_txt(content: str, source: str) -> list[ParsedDependency]:
    deps: list[ParsedDependency] = []
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("-"):
            continue
        m = _REQ_LINE.match(stripped)
        if m:
            name = normalize_py_name(m.group(1))
            version_part = m.group(2)
            if version_part:
                version = re.sub(r"^[<>=!~]+\s*", "", version_part).strip()
            else:
                version = "*"
            deps.append(
                ParsedDependency(
                    name=name,
                    version=version,
                    registry="pypi",
                    source=source,
                    dependency_type="runtime",
                )
            )
    return deps
