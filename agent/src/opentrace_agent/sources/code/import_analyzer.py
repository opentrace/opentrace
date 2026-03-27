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

"""Per-language import analysis using Tree-sitter ASTs.

Parses import statements from already-parsed source files and maps local
aliases to repo-relative file paths, enabling module-qualified call resolution.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import tree_sitter

from opentrace_agent.sources.code.manifest_parser import normalize_py_name


@dataclass
class ImportResult:
    """Result of import analysis: internal file refs + external package refs."""

    internal: dict[str, str] = field(default_factory=dict)
    """alias → repo-relative file path for locally-resolvable imports."""
    external: dict[str, str] = field(default_factory=dict)
    """package name → package ID (``pkg:registry:name``) for external deps."""


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


# ---------------------------------------------------------------------------
# Python imports
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Go imports (with cached directory index)
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
        # External dependency — skip if it's the project's own module path
        if go_module_path and import_path.startswith(go_module_path):
            return
        module_root = _go_module_root(import_path)
        external[module_root] = package_id("go", module_root)


# ---------------------------------------------------------------------------
# TypeScript/JavaScript imports
# ---------------------------------------------------------------------------


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

    Handles scoped packages: ``@scope/pkg/sub`` → ``@scope/pkg``.
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


# ---------------------------------------------------------------------------
# Rust imports
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Ruby imports
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Path utilities
# ---------------------------------------------------------------------------


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
