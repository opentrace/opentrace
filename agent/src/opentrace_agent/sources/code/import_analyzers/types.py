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

"""Shared types and helpers for import analysis."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ImportResult:
    """Result of import analysis: internal file refs + external package refs."""

    internal: dict[str, str] = field(default_factory=dict)
    """alias -> repo-relative file path for locally-resolvable imports."""
    external: dict[str, str] = field(default_factory=dict)
    """package name -> package ID (``pkg:registry:name``) for external deps."""


def package_id(registry: str, name: str) -> str:
    """Build a deterministic package node ID."""
    return f"pkg:{registry}:{name}"


def package_source_url(registry: str, name: str) -> str | None:
    """Return the canonical web URL for a package, or None."""
    urls = {
        "npm": f"https://www.npmjs.com/package/{name}",
        "pypi": f"https://pypi.org/project/{name}/",
        "go": f"https://pkg.go.dev/{name}",
        "crates": f"https://crates.io/crates/{name}",
        "rubygems": f"https://rubygems.org/gems/{name}",
    }
    return urls.get(registry)
