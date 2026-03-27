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

"""Ruby import analysis using Tree-sitter ASTs."""

from __future__ import annotations

import tree_sitter

from opentrace_agent.sources.code.import_analyzers.path_utils import (
    _parent_dir,
    _resolve_relative_path,
)
from opentrace_agent.sources.code.import_analyzers.types import ImportResult, package_id


def analyze_ruby_imports(
    root_node: tree_sitter.Node,
    file_path: str,
    known_files: set[str],
) -> ImportResult:
    """Extract Ruby imports (require and require_relative statements)."""
    internal: dict[str, str] = {}
    external: dict[str, str] = {}
    file_dir = _parent_dir(file_path)

    for child in root_node.children:
        if child.type == "call":
            func_node = child.children[0] if child.children else None
            if not func_node or func_node.type != "identifier":
                continue
            func_name = func_node.text.decode()

            if func_name == "require_relative":
                require_path = _extract_ruby_string_arg(child)
                if not require_path:
                    continue
                resolved = _resolve_relative_path(file_dir, require_path)
                candidates = [f"{resolved}.rb", resolved, f"{resolved}/index.rb"]
                for candidate in candidates:
                    if candidate in known_files:
                        alias = require_path.rsplit("/", 1)[-1]
                        internal[alias] = candidate
                        break

            elif func_name == "require":
                gem_name = _extract_ruby_string_arg(child)
                if not gem_name:
                    continue
                candidates = [
                    f"{gem_name}.rb",
                    f"lib/{gem_name}.rb",
                    f"{gem_name}/init.rb",
                ]
                found = False
                for candidate in candidates:
                    if candidate in known_files:
                        internal[gem_name] = candidate
                        found = True
                        break
                if not found:
                    name = gem_name.split("/")[0]
                    external[name] = package_id("rubygems", name)

    return ImportResult(internal=internal, external=external)


def _extract_ruby_string_arg(call_node: tree_sitter.Node) -> str | None:
    """Extract the string argument from a Ruby require/require_relative call."""
    arg_node = call_node.child_by_field_name("arguments")
    if arg_node is None:
        # Try finding argument_list child
        for c in call_node.children:
            if c.type == "argument_list":
                arg_node = c
                break
    if arg_node is None:
        return None

    for c in arg_node.children:
        if c.type == "string":
            for sc in c.children:
                if sc.type == "string_content":
                    return sc.text.decode()
    return None
