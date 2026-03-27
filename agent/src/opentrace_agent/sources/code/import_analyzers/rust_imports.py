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

"""Rust import analysis using Tree-sitter ASTs."""

from __future__ import annotations

import tree_sitter

from opentrace_agent.sources.code.import_analyzers.path_utils import _parent_dir
from opentrace_agent.sources.code.import_analyzers.types import ImportResult, package_id

_RUST_BUILTINS = frozenset({"std", "core", "alloc", "self", "super", "crate"})


def analyze_rust_imports(
    root_node: tree_sitter.Node,
    file_path: str,
    known_files: set[str],
) -> ImportResult:
    """Extract Rust imports (mod declarations and use statements)."""
    internal: dict[str, str] = {}
    external: dict[str, str] = {}
    file_dir = _parent_dir(file_path)

    for child in root_node.children:
        if child.type == "mod_item":
            name_node = child.child_by_field_name("name")
            if not name_node:
                continue
            # Only external mod declarations (with `;`), not inline `mod foo { ... }`
            has_body = any(c.type == "declaration_list" for c in child.children)
            if has_body:
                continue

            mod_name = name_node.text.decode()
            candidates = [
                f"{file_dir}/{mod_name}.rs" if file_dir else f"{mod_name}.rs",
                f"{file_dir}/{mod_name}/mod.rs" if file_dir else f"{mod_name}/mod.rs",
            ]
            found = False
            for candidate in candidates:
                if candidate in known_files:
                    internal[mod_name] = candidate
                    found = True
                    break
            if not found:
                external[mod_name] = package_id("crates", mod_name)

        elif child.type == "use_declaration":
            _parse_rust_use_decl(child, file_dir, known_files, internal, external)

    return ImportResult(internal=internal, external=external)


def _parse_rust_use_decl(
    node: tree_sitter.Node,
    file_dir: str,
    known_files: set[str],
    internal: dict[str, str],
    external: dict[str, str],
) -> None:
    """Parse a Rust use declaration and resolve the root crate/module."""
    for child in node.children:
        if child.type == "scoped_identifier":
            parts = child.text.decode().split("::")
            root = parts[0]
            _resolve_rust_root(root, file_dir, known_files, internal, external)
        elif child.type == "scoped_use_list":
            for sub in child.children:
                if sub.type in ("identifier", "scoped_identifier"):
                    root = sub.text.decode().split("::")[0]
                    _resolve_rust_root(root, file_dir, known_files, internal, external)
                    break
        elif child.type == "identifier":
            _resolve_rust_root(child.text.decode(), file_dir, known_files, internal, external)


def _resolve_rust_root(
    root: str,
    file_dir: str,
    known_files: set[str],
    internal: dict[str, str],
    external: dict[str, str],
) -> None:
    """Resolve a Rust crate root to a local file or external package."""
    if root in _RUST_BUILTINS:
        return

    if root not in internal:
        candidates = [
            f"{file_dir}/{root}.rs" if file_dir else f"{root}.rs",
            f"{file_dir}/{root}/mod.rs" if file_dir else f"{root}/mod.rs",
            f"src/{root}.rs",
            f"src/{root}/mod.rs",
        ]
        for candidate in candidates:
            if candidate in known_files:
                internal[root] = candidate
                return
        external[root] = package_id("crates", root)
