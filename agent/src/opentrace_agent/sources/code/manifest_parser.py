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

"""Manifest file parsers — extract dependency declarations from package manifests.

Ported from the UI's ``manifestParser.ts`` to produce identical output.
Supports: package.json, go.mod, requirements.txt, pyproject.toml, Cargo.toml.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field


@dataclass
class ParsedDependency:
    """A single dependency declaration from a manifest file."""

    name: str
    version: str
    registry: str  # "npm", "pypi", "go", "crates"
    source: str  # manifest filename
    dependency_type: str  # "runtime", "dev", "peer", "optional", "indirect"


@dataclass
class ManifestParseResult:
    """Result of parsing a manifest file."""

    dependencies: list[ParsedDependency] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


_MANIFEST_NAMES: frozenset[str] = frozenset(
    {
        "package.json",
        "go.mod",
        "requirements.txt",
        "pyproject.toml",
        "Cargo.toml",
    }
)

_LOCK_NAMES: frozenset[str] = frozenset(
    {
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "go.sum",
        "poetry.lock",
        "Cargo.lock",
        "uv.lock",
    }
)


def is_manifest_file(filename: str) -> bool:
    """Check whether *filename* (basename only) is a recognised manifest."""
    basename = filename.rsplit("/", 1)[-1]
    if basename in _LOCK_NAMES:
        return False
    return basename in _MANIFEST_NAMES


def normalize_py_name(name: str) -> str:
    """Normalize a Python package name: lowercase, underscores → dashes."""
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_manifest(filename: str, content: str) -> list[ParsedDependency]:
    """Dispatch to the right parser based on *filename*.

    Returns a flat list of dependencies for backward compatibility.
    Use :func:`parse_manifest_result` if you also want error tracking.
    """
    return parse_manifest_result(filename, content).dependencies


def parse_manifest_result(filename: str, content: str) -> ManifestParseResult:
    """Dispatch to the right parser based on *filename*, returning errors too."""
    basename = filename.rsplit("/", 1)[-1]
    parsers = {
        "package.json": parse_package_json,
        "go.mod": parse_go_mod,
        "requirements.txt": parse_requirements_txt,
        "pyproject.toml": parse_pyproject_toml,
        "Cargo.toml": parse_cargo_toml,
    }
    parser = parsers.get(basename)
    if parser is None:
        return ManifestParseResult()
    try:
        deps = parser(content, filename)
        return ManifestParseResult(dependencies=deps)
    except Exception as exc:  # noqa: BLE001
        return ManifestParseResult(errors=[f"{filename}: {exc}"])


# ---------------------------------------------------------------------------
# package.json
# ---------------------------------------------------------------------------

_NPM_SECTIONS = {
    "dependencies": "runtime",
    "devDependencies": "dev",
    "peerDependencies": "peer",
    "optionalDependencies": "optional",
}


def parse_package_json(content: str, source: str) -> list[ParsedDependency]:
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        return []
    deps: list[ParsedDependency] = []
    for section, dep_type in _NPM_SECTIONS.items():
        section_data = data.get(section)
        if not isinstance(section_data, dict):
            continue
        for name, version in section_data.items():
            deps.append(
                ParsedDependency(
                    name=name,
                    version=str(version),
                    registry="npm",
                    source=source,
                    dependency_type=dep_type,
                )
            )
    return deps


# ---------------------------------------------------------------------------
# go.mod
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# requirements.txt
# ---------------------------------------------------------------------------

_REQ_LINE = re.compile(
    r"^([A-Za-z0-9_.-]+)(?:\[.*?\])?\s*([<>=!~]+\s*\S+)?",
)


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


# ---------------------------------------------------------------------------
# pyproject.toml  (line-based state machine — no TOML library needed)
# ---------------------------------------------------------------------------


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


def _parse_pep508_line(spec: str) -> tuple[str, str] | None:
    """Parse a PEP 508 dependency spec like ``requests>=2.0`` → (name, version)."""
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


# ---------------------------------------------------------------------------
# Cargo.toml  (line-based)
# ---------------------------------------------------------------------------


def parse_cargo_toml(content: str, source: str) -> list[ParsedDependency]:
    deps: list[ParsedDependency] = []
    section: str | None = None

    for line in content.splitlines():
        stripped = line.strip()

        if stripped.startswith("["):
            section = stripped.strip("[]").strip()
            continue

        if section in ("dependencies", "dev-dependencies", "build-dependencies"):
            dep_type = {
                "dependencies": "runtime",
                "dev-dependencies": "dev",
                "build-dependencies": "dev",
            }[section]
            if "=" in stripped and not stripped.startswith("#"):
                name, _, value = stripped.partition("=")
                name = name.strip()
                value = value.strip().strip('"')
                # Handle inline table: foo = { version = "1.0", features = [...] }
                if value.startswith("{"):
                    vm = re.search(r'version\s*=\s*"([^"]*)"', value)
                    version = vm.group(1) if vm else "*"
                else:
                    version = value
                deps.append(
                    ParsedDependency(
                        name=name,
                        version=version,
                        registry="crates",
                        source=source,
                        dependency_type=dep_type,
                    )
                )

    return deps
