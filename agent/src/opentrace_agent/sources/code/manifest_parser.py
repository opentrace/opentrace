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
from dataclasses import dataclass


@dataclass
class ParsedDependency:
    """A single dependency declaration from a manifest file."""

    name: str
    version: str
    registry: str  # "npm", "pypi", "go", "crates"
    source: str  # manifest filename
    dependency_type: str  # "runtime", "dev", "peer", "optional", "indirect"


_MANIFEST_NAMES: frozenset[str] = frozenset(
    {
        "package.json",
        "go.mod",
        "requirements.txt",
        "pyproject.toml",
        "Cargo.toml",
    }
)


def is_manifest_file(filename: str) -> bool:
    """Check whether *filename* (basename only) is a recognised manifest."""
    basename = filename.rsplit("/", 1)[-1]
    return basename in _MANIFEST_NAMES


def parse_manifest(filename: str, content: str) -> list[ParsedDependency]:
    """Dispatch to the right parser based on *filename*."""
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
        return []
    return parser(content, filename)


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
            stripped.split(None, 1)[1].strip()  # module path (unused for now)
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
    r"^([A-Za-z0-9][\w.\-]*)",
)
_REQ_VERSION = re.compile(
    r"[><=!~]+\s*(\S+)",
)


def parse_requirements_txt(content: str, source: str) -> list[ParsedDependency]:
    deps: list[ParsedDependency] = []
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("-"):
            continue
        m = _REQ_LINE.match(stripped)
        if m:
            name = m.group(1)
            version_match = _REQ_VERSION.search(stripped)
            version = version_match.group(1) if version_match else "*"
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


def parse_pyproject_toml(content: str, source: str) -> list[ParsedDependency]:
    deps: list[ParsedDependency] = []
    section: str | None = None

    for line in content.splitlines():
        stripped = line.strip()

        # Section headers
        if stripped.startswith("["):
            section = stripped.strip("[]").strip()
            continue

        if section == "project.dependencies":
            # Array entry: "requests>=2.0"
            if stripped.startswith('"') or stripped.startswith("'"):
                dep = _parse_pep508_line(stripped.strip("\"', "))
                if dep:
                    deps.append(
                        ParsedDependency(
                            name=dep[0],
                            version=dep[1],
                            registry="pypi",
                            source=source,
                            dependency_type="runtime",
                        )
                    )
        elif section == "project":
            # Inline: dependencies = ["requests>=2.0", ...]
            if stripped.startswith("dependencies") and "=" in stripped:
                for item in re.findall(r'"([^"]+)"', stripped):
                    dep = _parse_pep508_line(item)
                    if dep:
                        deps.append(
                            ParsedDependency(
                                name=dep[0],
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
                            name=dep[0],
                            version=dep[1],
                            registry="pypi",
                            source=source,
                            dependency_type="optional",
                        )
                    )

    return deps


def _parse_pep508_line(spec: str) -> tuple[str, str] | None:
    """Parse a PEP 508 dependency spec like ``requests>=2.0`` → (name, version)."""
    m = re.match(r"^([A-Za-z0-9][\w.\-]*)", spec)
    if not m:
        return None
    name = m.group(1)
    rest = spec[m.end() :]
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
