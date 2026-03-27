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

"""Shared path utility functions for import analyzers."""

from __future__ import annotations


def _parent_dir(path: str) -> str:
    """Get parent directory of a path string."""
    parts = path.rsplit("/", 1)
    return parts[0] if len(parts) > 1 else ""


def _module_to_paths(module_name: str) -> list[str]:
    """Convert a dotted module name to candidate file paths."""
    path = module_name.replace(".", "/")
    return [f"{path}.py", f"{path}/__init__.py"]


def _resolve_relative_path(base_dir: str, relative: str) -> str:
    """Resolve a relative path like './foo' or '../bar' from a base directory."""
    parts = relative.split("/")
    base_parts = base_dir.split("/") if base_dir else []

    for part in parts:
        if part == ".":
            continue
        elif part == "..":
            if base_parts:
                base_parts.pop()
        else:
            base_parts.append(part)

    return "/".join(base_parts)
