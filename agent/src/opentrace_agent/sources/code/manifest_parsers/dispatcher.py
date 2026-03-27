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

"""Manifest parser dispatcher — routes filenames to the correct format parser."""

from __future__ import annotations

from opentrace_agent.sources.code.manifest_parsers.cargo_parser import parse_cargo_toml
from opentrace_agent.sources.code.manifest_parsers.go_parser import parse_go_mod
from opentrace_agent.sources.code.manifest_parsers.npm_parser import parse_package_json
from opentrace_agent.sources.code.manifest_parsers.pip_parser import (
    parse_requirements_txt,
)
from opentrace_agent.sources.code.manifest_parsers.pyproject_parser import (
    parse_pyproject_toml,
)
from opentrace_agent.sources.code.manifest_parsers.types import (
    ManifestParseResult,
    ParsedDependency,
)

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
