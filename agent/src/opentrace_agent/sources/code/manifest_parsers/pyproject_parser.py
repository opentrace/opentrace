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

"""Parser for pyproject.toml manifest files (line-based state machine -- no TOML library needed)."""

from __future__ import annotations

import re

from opentrace_agent.sources.code.manifest_parsers.pip_parser import normalize_py_name
from opentrace_agent.sources.code.manifest_parsers.types import ParsedDependency


def _collect_toml_array(lines: list[str], start_idx: int) -> tuple[list[str], int]:
    """Collect a TOML array that may span multiple lines.

    Starting from the line *after* the opening ``[``, reads lines until brackets
    are balanced.  Returns (collected_items, next_line_index).
    """
    items: list[str] = []
    depth = 1  # we've already seen the opening [
    idx = start_idx

    while idx < len(lines) and depth > 0:
        line = lines[idx].strip()
        for ch in line:
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    break
        # Extract quoted strings from this line
        items.extend(re.findall(r'"([^"]+)"', line))
        items.extend(re.findall(r"'([^']+)'", line))
        idx += 1

    return items, idx


def _parse_pep508_line(spec: str) -> tuple[str, str] | None:
    """Parse a PEP 508 dependency spec like ``requests>=2.0`` -> (name, version)."""
    m = re.match(r"^([A-Za-z0-9][\w.\-]*)", spec)
    if not m:
        return None
    name = m.group(1)
    rest = spec[m.end() :]
    # Strip extras like [security]
    rest = re.sub(r"^\[.*?\]", "", rest)
    version_match = re.search(r"[><=!~]+\s*(\S+)", rest)
    version = version_match.group(1).rstrip(",;") if version_match else "*"
    return name, version


def parse_pyproject_toml(content: str, source: str) -> list[ParsedDependency]:
    deps: list[ParsedDependency] = []
    lines = content.splitlines()
    section: str | None = None
    i = 0

    while i < len(lines):
        stripped = lines[i].strip()

        # Section headers
        if stripped.startswith("["):
            section = stripped.strip("[]").strip()
            i += 1
            continue

        if section == "project.dependencies":
            # Array entry: "requests>=2.0"
            if stripped.startswith('"') or stripped.startswith("'"):
                dep = _parse_pep508_line(stripped.strip("\"', "))
                if dep:
                    deps.append(
                        ParsedDependency(
                            name=normalize_py_name(dep[0]),
                            version=dep[1],
                            registry="pypi",
                            source=source,
                            dependency_type="runtime",
                        )
                    )
        elif section == "project":
            # Inline or multi-line: dependencies = ["requests>=2.0", ...]
            if stripped.startswith("dependencies") and "=" in stripped:
                after_eq = stripped.split("=", 1)[1].strip()
                if "[" in after_eq:
                    # Check if the array closes on this line
                    if "]" in after_eq:
                        items = re.findall(r'"([^"]+)"', after_eq)
                    else:
                        # Multi-line array
                        items, i = _collect_toml_array(lines, i + 1)
                        # Don't increment i again at the end
                        for item in items:
                            dep = _parse_pep508_line(item)
                            if dep:
                                deps.append(
                                    ParsedDependency(
                                        name=normalize_py_name(dep[0]),
                                        version=dep[1],
                                        registry="pypi",
                                        source=source,
                                        dependency_type="runtime",
                                    )
                                )
                        continue
                    for item in items:
                        dep = _parse_pep508_line(item)
                        if dep:
                            deps.append(
                                ParsedDependency(
                                    name=normalize_py_name(dep[0]),
                                    version=dep[1],
                                    registry="pypi",
                                    source=source,
                                    dependency_type="runtime",
                                )
                            )

        elif section and section.startswith("project.optional-dependencies"):
            if stripped.startswith('"') or stripped.startswith("'"):
                dep = _parse_pep508_line(stripped.strip("\"', "))
                if dep:
                    deps.append(
                        ParsedDependency(
                            name=normalize_py_name(dep[0]),
                            version=dep[1],
                            registry="pypi",
                            source=source,
                            dependency_type="optional",
                        )
                    )

        elif section == "tool.poetry.dependencies":
            # Poetry: key = "version" or key = {version = "..."}
            if "=" in stripped and not stripped.startswith("#"):
                name, _, value = stripped.partition("=")
                name = name.strip().strip('"')
                if name == "python":
                    i += 1
                    continue
                value = value.strip()
                if value.startswith("{"):
                    vm = re.search(r'version\s*=\s*"([^"]*)"', value)
                    version = vm.group(1) if vm else "*"
                else:
                    version = value.strip('"')
                deps.append(
                    ParsedDependency(
                        name=normalize_py_name(name),
                        version=version,
                        registry="pypi",
                        source=source,
                        dependency_type="runtime",
                    )
                )

        elif section == "tool.poetry.dev-dependencies":
            if "=" in stripped and not stripped.startswith("#"):
                name, _, value = stripped.partition("=")
                name = name.strip().strip('"')
                value = value.strip()
                if value.startswith("{"):
                    vm = re.search(r'version\s*=\s*"([^"]*)"', value)
                    version = vm.group(1) if vm else "*"
                else:
                    version = value.strip('"')
                deps.append(
                    ParsedDependency(
                        name=normalize_py_name(name),
                        version=version,
                        registry="pypi",
                        source=source,
                        dependency_type="dev",
                    )
                )

        i += 1

    return deps
