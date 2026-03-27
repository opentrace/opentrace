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

"""Python import analysis using Tree-sitter ASTs."""

from __future__ import annotations

import tree_sitter

from opentrace_agent.sources.code.import_analyzers.path_utils import (
    _module_to_paths,
    _parent_dir,
)
from opentrace_agent.sources.code.import_analyzers.types import ImportResult, package_id
from opentrace_agent.sources.code.manifest_parser import normalize_py_name


def analyze_python_imports(
    root_node: tree_sitter.Node,
    file_path: str,
    known_files: set[str],
) -> ImportResult:
    """Extract Python imports and map local module names to repo file IDs."""
    internal: dict[str, str] = {}
    external: dict[str, str] = {}
    file_dir = _parent_dir(file_path)

    for child in root_node.children:
        if child.type == "import_statement":
            _parse_python_import(child, known_files, internal, external)
        elif child.type == "import_from_statement":
            _parse_python_from_import(child, file_dir, known_files, internal, external)

    return ImportResult(internal=internal, external=external)


def _parse_python_import(
    node: tree_sitter.Node,
    known_files: set[str],
    result: dict[str, str],
    external: dict[str, str],
) -> None:
    """Parse ``import foo`` or ``import foo as bar``."""
    for child in node.children:
        if child.type == "dotted_name":
            module_name = child.text.decode()
            candidates = _module_to_paths(module_name)
            resolved = False
            for candidate in candidates:
                if candidate in known_files:
                    result[module_name.split(".")[-1]] = candidate
                    resolved = True
                    break
            if not resolved:
                top_level = module_name.split(".")[0]
                name = normalize_py_name(top_level)
                external[name] = package_id("pypi", name)
        elif child.type == "aliased_import":
            name_node = child.child_by_field_name("name")
            alias_node = child.child_by_field_name("alias")
            if name_node and alias_node:
                module_name = name_node.text.decode()
                alias = alias_node.text.decode()
                candidates = _module_to_paths(module_name)
                resolved = False
                for candidate in candidates:
                    if candidate in known_files:
                        result[alias] = candidate
                        resolved = True
                        break
                if not resolved:
                    top_level = module_name.split(".")[0]
                    name = normalize_py_name(top_level)
                    external[name] = package_id("pypi", name)


def _parse_python_from_import(
    node: tree_sitter.Node,
    file_dir: str,
    known_files: set[str],
    result: dict[str, str],
    external: dict[str, str],
) -> None:
    """Parse ``from module import name`` or ``from . import name``."""
    module_name_node = node.child_by_field_name("module_name")
    if module_name_node is None:
        return

    module_text = module_name_node.text.decode()

    # Check for relative imports (starts with dots)
    is_relative = False
    for child in node.children:
        if child.type == "relative_import":
            is_relative = True
            for sub in child.children:
                if sub.type == "dotted_name":
                    module_text = sub.text.decode()
                elif sub.type == "import_prefix":
                    dots = sub.text.decode()
                    base_dir = file_dir
                    for _ in range(len(dots) - 1):
                        base_dir = _parent_dir(base_dir)
                    if module_text == module_name_node.text.decode() and module_text.startswith("."):
                        module_text = ""
            break

    if is_relative:
        if module_text:
            base_path = f"{file_dir}/{module_text.replace('.', '/')}" if file_dir else module_text.replace(".", "/")
        else:
            base_path = file_dir
        candidates = [f"{base_path}.py", f"{base_path}/__init__.py"]
    else:
        candidates = _module_to_paths(module_text)

    resolved_path: str | None = None
    for candidate in candidates:
        if candidate in known_files:
            alias = module_text.split(".")[-1] if module_text else ""
            if alias:
                result[alias] = candidate
            resolved_path = candidate
            break

    if resolved_path is not None:
        for child in node.children:
            if child.type == "dotted_name" and child != node.child_by_field_name("module_name"):
                result[child.text.decode()] = resolved_path
            elif child.type == "aliased_import":
                name_node = child.child_by_field_name("name")
                alias_node = child.child_by_field_name("alias")
                if alias_node:
                    result[alias_node.text.decode()] = resolved_path
                elif name_node:
                    result[name_node.text.decode()] = resolved_path
    elif not is_relative:
        top_level = module_text.split(".")[0]
        name = normalize_py_name(top_level)
        external[name] = package_id("pypi", name)
