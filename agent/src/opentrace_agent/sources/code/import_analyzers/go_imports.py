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

"""Go import analysis using Tree-sitter ASTs."""

from __future__ import annotations

import tree_sitter

from opentrace_agent.sources.code.import_analyzers.path_utils import _parent_dir
from opentrace_agent.sources.code.import_analyzers.types import ImportResult, package_id

# ---------------------------------------------------------------------------
# Directory index cache
# ---------------------------------------------------------------------------

_cached_dir_index: dict[str, str] | None = None
_cached_dir_index_source: frozenset[str] | None = None


def reset_dir_index_cache() -> None:
    """Reset the directory index cache (for test isolation)."""
    global _cached_dir_index, _cached_dir_index_source  # noqa: PLW0603
    _cached_dir_index = None
    _cached_dir_index_source = None


def _build_dir_index(known_files: set[str]) -> dict[str, str]:
    """Build an O(1) directory index from known file paths.

    Maps full directory paths and unambiguous basenames to a representative
    Go file for fast import resolution.
    """
    dir_to_file: dict[str, str] = {}
    basename_counts: dict[str, int] = {}
    basename_to_dir: dict[str, str] = {}

    for path in known_files:
        if not path.endswith(".go"):
            continue
        d = _parent_dir(path)
        if d and d not in dir_to_file:
            dir_to_file[d] = path
            base = d.rsplit("/", 1)[-1]
            basename_counts[base] = basename_counts.get(base, 0) + 1
            basename_to_dir[base] = d

    # Add shortcut for unambiguous basenames
    for base, count in basename_counts.items():
        if count == 1:
            full_dir = basename_to_dir[base]
            if base not in dir_to_file:
                dir_to_file[base] = dir_to_file[full_dir]

    return dir_to_file


def _get_dir_index(known_files: set[str]) -> dict[str, str]:
    """Get or build the directory index, caching across calls."""
    global _cached_dir_index, _cached_dir_index_source  # noqa: PLW0603
    frozen = frozenset(known_files)
    if _cached_dir_index is not None and _cached_dir_index_source == frozen:
        return _cached_dir_index
    _cached_dir_index = _build_dir_index(known_files)
    _cached_dir_index_source = frozen
    return _cached_dir_index


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def analyze_go_imports(
    root_node: tree_sitter.Node,
    known_files: set[str],
    go_module_path: str | None = None,
) -> ImportResult:
    """Extract Go imports and map package aliases to repo file IDs."""
    internal: dict[str, str] = {}
    external: dict[str, str] = {}

    for child in root_node.children:
        if child.type == "import_declaration":
            _parse_go_import_decl(child, known_files, internal, external, go_module_path)

    return ImportResult(internal=internal, external=external)


def _parse_go_import_decl(
    node: tree_sitter.Node,
    known_files: set[str],
    result: dict[str, str],
    external: dict[str, str],
    go_module_path: str | None,
) -> None:
    """Parse a Go import declaration (single or grouped)."""
    for child in node.children:
        if child.type == "import_spec":
            _parse_go_import_spec(child, known_files, result, external, go_module_path)
        elif child.type == "import_spec_list":
            for spec in child.children:
                if spec.type == "import_spec":
                    _parse_go_import_spec(spec, known_files, result, external, go_module_path)


_GO_MODULE_HOSTS = frozenset({
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "golang.org",
    "google.golang.org",
    "gopkg.in",
})


def _go_module_root(import_path: str) -> str:
    """Extract the module root from a Go import path.

    For known hosting platforms, the module root is the first 3 segments.
    For unknown hosts, also use up to 3 segments as a reasonable default.
    """
    parts = import_path.split("/")
    if len(parts) >= 3 and parts[0] in _GO_MODULE_HOSTS:
        return "/".join(parts[:3])
    # Fallback: up to 3 segments for unknown hosts
    if len(parts) >= 3:
        return "/".join(parts[:3])
    return import_path


def _parse_go_import_spec(
    node: tree_sitter.Node,
    known_files: set[str],
    result: dict[str, str],
    external: dict[str, str],
    go_module_path: str | None,
) -> None:
    """Parse a single Go import spec using the directory index for O(1) lookup."""
    path_node = node.child_by_field_name("path")
    name_node = node.child_by_field_name("name")

    if path_node is None:
        return

    import_path = path_node.text.decode().strip('"')

    # Skip stdlib (no slash usually means stdlib for Go)
    if "/" not in import_path:
        return

    # Determine alias
    if name_node:
        alias = name_node.text.decode()
        if alias == "_" or alias == ".":
            return
    else:
        alias = import_path.rsplit("/", 1)[-1]

    # Use directory index for fast lookup
    dir_index = _get_dir_index(known_files)
    pkg_name = import_path.rsplit("/", 1)[-1]

    resolved = False

    # Tier 1: full import path match
    if import_path in dir_index:
        result[alias] = dir_index[import_path]
        resolved = True
    else:
        # Tier 2: module-path-stripped repo-relative match
        if go_module_path and import_path.startswith(go_module_path + "/"):
            repo_relative = import_path[len(go_module_path) + 1 :]
            if repo_relative in dir_index:
                result[alias] = dir_index[repo_relative]
                resolved = True

        # Tier 3: bare package name (basename shortcut)
        if not resolved and pkg_name in dir_index:
            result[alias] = dir_index[pkg_name]
            resolved = True

    if not resolved:
        # External dependency -- skip if it's the project's own module path
        if go_module_path and import_path.startswith(go_module_path):
            return
        module_root = _go_module_root(import_path)
        external[module_root] = package_id("go", module_root)
