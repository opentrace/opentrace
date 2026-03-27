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

"""TypeScript/JavaScript import analysis using Tree-sitter ASTs."""

from __future__ import annotations

import tree_sitter

from opentrace_agent.sources.code.import_analyzers.path_utils import (
    _parent_dir,
    _resolve_relative_path,
)
from opentrace_agent.sources.code.import_analyzers.types import ImportResult, package_id


def analyze_typescript_imports(
    root_node: tree_sitter.Node,
    file_path: str,
    known_files: set[str],
) -> ImportResult:
    """Extract TypeScript/TSX imports and map aliases to repo file IDs."""
    internal: dict[str, str] = {}
    external: dict[str, str] = {}
    file_dir = _parent_dir(file_path)

    for child in root_node.children:
        if child.type == "import_statement":
            _parse_ts_import(child, file_dir, known_files, internal, external)
        elif child.type == "export_statement":
            _parse_ts_reexport(child, file_dir, known_files, internal)

    return ImportResult(internal=internal, external=external)


def _npm_package_name(specifier: str) -> str:
    """Extract the npm package name from a bare specifier.

    Handles scoped packages: ``@scope/pkg/sub`` -> ``@scope/pkg``.
    """
    if specifier.startswith("@"):
        parts = specifier.split("/")
        if len(parts) >= 2:
            return f"{parts[0]}/{parts[1]}"
        return specifier
    return specifier.split("/")[0]


def _parse_ts_import(
    node: tree_sitter.Node,
    file_dir: str,
    known_files: set[str],
    result: dict[str, str],
    external: dict[str, str],
) -> None:
    """Parse a TypeScript import statement."""
    source_node = node.child_by_field_name("source")
    if source_node is None:
        return

    source_text = source_node.text.decode().strip("'\"")

    if not source_text.startswith("."):
        pkg_name = _npm_package_name(source_text)
        external[pkg_name] = package_id("npm", pkg_name)
        return

    resolved = _resolve_relative_path(file_dir, source_text)

    extensions = [
        "",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        "/index.ts",
        "/index.tsx",
        "/index.js",
    ]
    for ext in extensions:
        candidate = resolved + ext
        if candidate in known_files:
            alias = source_text.rsplit("/", 1)[-1]
            result[alias] = candidate
            break


def _parse_ts_reexport(
    node: tree_sitter.Node,
    file_dir: str,
    known_files: set[str],
    result: dict[str, str],
) -> None:
    """Parse ``export { Config } from './config'`` as an import alias."""
    source_node = node.child_by_field_name("source")
    if source_node is None:
        return

    source_text = source_node.text.decode().strip("'\"")

    if not source_text.startswith("."):
        return

    resolved = _resolve_relative_path(file_dir, source_text)

    extensions = [
        "",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        "/index.ts",
        "/index.tsx",
        "/index.js",
    ]
    for ext in extensions:
        candidate = resolved + ext
        if candidate in known_files:
            alias = source_text.rsplit("/", 1)[-1]
            result[alias] = candidate
            break
