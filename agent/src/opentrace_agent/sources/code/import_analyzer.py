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

from collections.abc import Iterator
from dataclasses import dataclass, field

import tree_sitter


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


def analyze_python_imports(
    root_node: tree_sitter.Node,
    file_path: str,
    known_files: set[str],
) -> ImportResult:
    """Extract Python imports and map local module names to repo file IDs.

    Handles:
      - ``import utils`` → alias "utils"
      - ``import utils as u`` → alias "u"
      - ``from . import helper`` → relative import
      - ``from mypackage import foo`` → absolute local import

    Args:
        root_node: Tree-sitter root node of the parsed Python file.
        file_path: The repo-relative path of this file (e.g. "src/app/main.py").
        known_files: Set of all repo file IDs (paths) for local-import detection.

    Returns:
        ImportResult with internal (alias → file_id) and external (name → pkg ID).
    """
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
            top_level = module_name.split(".")[0]
            # Try to resolve module.submodule → module/submodule.py or module/submodule/__init__.py
            candidates = _module_to_paths(module_name)
            resolved = False
            for candidate in candidates:
                if candidate in known_files:
                    # ``import a.b.c`` binds only ``a`` in Python; attribute
                    # calls reference the full dotted path (``a.b.c.func()``),
                    # so register the full name — not the last segment, which
                    # is never a usable binding for a plain dotted import.
                    result[module_name] = candidate
                    resolved = True
                    break
            top_resolved = False
            if "." in module_name:
                # Also map the top-level package name (the actual binding).
                for candidate in _module_to_paths(top_level):
                    if candidate in known_files:
                        result.setdefault(top_level, candidate)
                        top_resolved = True
                        break
            if not resolved and not top_resolved:
                external[top_level] = package_id("pypi", top_level)
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
                    external[top_level] = package_id("pypi", top_level)


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
            # Extract the actual module path from the relative import
            for sub in child.children:
                if sub.type == "dotted_name":
                    module_text = sub.text.decode()
                elif sub.type == "import_prefix":
                    dots = sub.text.decode()
                    # Each dot goes up one level
                    base_dir = file_dir
                    for _ in range(len(dots) - 1):
                        base_dir = _parent_dir(base_dir)
                    if module_text == module_name_node.text.decode() and module_text.startswith("."):
                        module_text = ""
            break

    if is_relative:
        # For relative imports, resolve relative to file's directory
        if module_text:
            base_path = f"{file_dir}/{module_text.replace('.', '/')}" if file_dir else module_text.replace(".", "/")
        else:
            base_path = file_dir
        candidates = [f"{base_path}.py", f"{base_path}/__init__.py"]
    else:
        candidates = _module_to_paths(module_text)

    # Map the imported module alias
    resolved_path: str | None = None
    for candidate in candidates:
        if candidate in known_files:
            # The alias is the last part of the module name or the explicit alias
            alias = module_text.split(".")[-1] if module_text else ""
            if alias:
                result[alias] = candidate
            resolved_path = candidate
            break

    # Store individual imported symbol names from `from X import Y, Z`.
    # When X resolved to a package __init__.py, an imported name may be a
    # submodule (`from . import helper` with pkg/helper.py) — prefer the
    # module file and fall back to the __init__.py (symbol import) only
    # when no such module file exists.
    if resolved_path is not None:
        for child in node.children:
            if child.type == "dotted_name" and child != node.child_by_field_name("module_name"):
                # Bare imported name: `from X import Y`
                name = child.text.decode()
                result[name] = _package_submodule_path(resolved_path, name, known_files) or resolved_path
            elif child.type == "aliased_import":
                # `from X import Y as Z` — store the alias
                name_node = child.child_by_field_name("name")
                alias_node = child.child_by_field_name("alias")
                name = name_node.text.decode() if name_node else None
                target = resolved_path
                if name:
                    target = _package_submodule_path(resolved_path, name, known_files) or resolved_path
                if alias_node:
                    result[alias_node.text.decode()] = target
                elif name:
                    result[name] = target
    elif not is_relative:
        # External import: not resolved to any local file
        top_level = module_text.split(".")[0]
        external[top_level] = package_id("pypi", top_level)


def build_go_dir_index(known_files: set[str]) -> dict[str, str]:
    """Precompute directory → representative file for O(1) Go import resolution.

    Maps every known file's parent directory to the lexicographically smallest
    file it contains. Import specs are then resolved by probing the trailing
    path-component suffixes of the import path (see
    :func:`_lookup_go_package_file`) instead of scanning the whole file set per
    import spec — the same shape as the browser mirror's
    ``importAnalyzer.ts buildDirIndex``. (The TS index also keys unambiguous
    directory *basenames*; here every trailing suffix of the import path is
    probed instead, so no basename shortcut is needed.)

    Unlike the TS mirror this deliberately indexes files of every extension:
    the historical Python matching considered any known file (e.g. a lone
    ``.sql`` file in the package directory still resolved the import), and
    that behaviour is preserved.

    Build this once per repo and pass it to :func:`analyze_go_imports` when
    analyzing many files against the same file set.
    """
    index: dict[str, str] = {}
    for path in known_files:
        d = _parent_dir(path)
        cur = index.get(d)
        if cur is None or path < cur:
            index[d] = path
    return index


def _iter_trailing_dirs(path: str) -> Iterator[str]:
    """Yield *path* and every trailing path-component suffix.

    ``"a/b/c"`` → ``"a/b/c"``, ``"b/c"``, ``"c"``.
    """
    yield path
    idx = path.find("/")
    while idx != -1:
        yield path[idx + 1 :]
        idx = path.find("/", idx + 1)


def _lookup_go_package_file(
    dir_index: dict[str, str],
    rel_path: str,
    import_path: str,
) -> str | None:
    """Find the known file that resolves a Go import path, or None.

    A known directory matches when it equals — or is a trailing
    path-component suffix of — the import path (both the raw path and the
    module-prefix-stripped one are probed). Matching only the last segment
    would wrongly link unrelated third-party packages (e.g.
    ``github.com/other/store``) to any local dir named ``store``. The set of
    matching directories is exactly what the historical full scan over
    ``known_files`` produced.

    Among multiple matching files the lexicographically smallest path wins.
    The historical scan returned whichever match came first in ``set``
    iteration order, which is str-hash dependent and therefore varied between
    processes (PYTHONHASHSEED is not pinned anywhere in the agent) — the
    multi-candidate pick was already nondeterministic across runs, so this
    deterministic tie-break is an improvement, not a behaviour change for any
    pick that was previously stable. Single-candidate resolutions (by far the
    common case) are byte-identical to the old behaviour.
    """
    best: str | None = None
    for cand_dir in _iter_trailing_dirs(rel_path):
        f = dir_index.get(cand_dir)
        if f is not None and (best is None or f < best):
            best = f
    if import_path != rel_path:
        for cand_dir in _iter_trailing_dirs(import_path):
            f = dir_index.get(cand_dir)
            if f is not None and (best is None or f < best):
                best = f
    return best


def analyze_go_imports(
    root_node: tree_sitter.Node,
    known_files: set[str],
    go_module_path: str | None = None,
    dir_index: dict[str, str] | None = None,
) -> ImportResult:
    """Extract Go imports and map package aliases to repo file IDs.

    Handles:
      - ``import "myproject/internal/store"`` → alias "store"
      - ``import s "myproject/internal/store"`` → alias "s"

    Args:
        root_node: Tree-sitter root node of the parsed Go file.
        known_files: Set of all repo file IDs (paths) for local-import detection.
        go_module_path: Module path from go.mod, when known.
        dir_index: Optional precomputed :func:`build_go_dir_index` for
            *known_files*. The pipeline builds it once per repo; when omitted
            it is built on the fly from *known_files*.

    Returns:
        ImportResult with internal (alias → file_id) and external (name → pkg ID).
    """
    internal: dict[str, str] = {}
    external: dict[str, str] = {}
    if dir_index is None:
        dir_index = build_go_dir_index(known_files)

    for child in root_node.children:
        if child.type == "import_declaration":
            _parse_go_import_decl(child, dir_index, internal, external, go_module_path)

    return ImportResult(internal=internal, external=external)


def _parse_go_import_decl(
    node: tree_sitter.Node,
    dir_index: dict[str, str],
    result: dict[str, str],
    external: dict[str, str],
    go_module_path: str | None,
) -> None:
    """Parse a Go import declaration (single or grouped)."""
    for child in node.children:
        if child.type == "import_spec":
            _parse_go_import_spec(child, dir_index, result, external, go_module_path)
        elif child.type == "import_spec_list":
            for spec in child.children:
                if spec.type == "import_spec":
                    _parse_go_import_spec(spec, dir_index, result, external, go_module_path)


def _go_module_root(import_path: str) -> str:
    """Extract the module root from a Go import path.

    For known hosting platforms (github.com, gitlab.com, bitbucket.org),
    the module root is the first 3 segments. Otherwise, use the full path.
    """
    parts = import_path.split("/")
    if len(parts) >= 3 and parts[0] in (
        "github.com",
        "gitlab.com",
        "bitbucket.org",
    ):
        return "/".join(parts[:3])
    return import_path


def _parse_go_import_spec(
    node: tree_sitter.Node,
    dir_index: dict[str, str],
    result: dict[str, str],
    external: dict[str, str],
    go_module_path: str | None,
) -> None:
    """Parse a single Go import spec."""
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
        # Default alias is the last path segment
        alias = import_path.rsplit("/", 1)[-1]

    # Try to find matching files — match directory-based Go packages.
    # The import path may have a module prefix (e.g. "myproject/internal/store")
    # but the known files use repo-relative paths (e.g. "internal/store/store.go").
    # Strip the module prefix when we know it so the path is repo-relative.
    rel_path = import_path
    if go_module_path and import_path.startswith(go_module_path):
        rel_path = import_path[len(go_module_path) :].lstrip("/")
    resolved_file = _lookup_go_package_file(dir_index, rel_path, import_path)
    if resolved_file is not None:
        result[alias] = resolved_file

    if resolved_file is None:
        # External dependency — skip if it's the project's own module path
        if go_module_path and import_path.startswith(go_module_path):
            return
        module_root = _go_module_root(import_path)
        external[module_root] = package_id("go", module_root)


def analyze_typescript_imports(
    root_node: tree_sitter.Node,
    file_path: str,
    known_files: set[str],
) -> ImportResult:
    """Extract TypeScript/TSX imports and map aliases to repo file IDs.

    Handles:
      - ``import { foo } from './utils'`` → alias "utils"
      - ``import utils from '../lib/utils'`` → alias "utils"
      - Bare specifier imports produce external Package references

    Returns:
        ImportResult with internal (alias → file_id) and external (name → pkg ID).
    """
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
    Plain packages: ``lodash/fp`` → ``lodash``.
    """
    if specifier.startswith("@"):
        parts = specifier.split("/")
        if len(parts) >= 2:
            return f"{parts[0]}/{parts[1]}"
        return specifier
    return specifier.split("/")[0]


def _ts_specifier_local_name(spec: tree_sitter.Node) -> str | None:
    """Local binding name of an import/export specifier (``alias`` if renamed)."""
    local = spec.child_by_field_name("alias") or spec.child_by_field_name("name")
    return local.text.decode() if local is not None else None


def _ts_import_bindings(node: tree_sitter.Node) -> list[str]:
    """Local binding names introduced by a TS ``import`` statement.

    Returns the names actually usable in code — the default import, the
    ``* as ns`` namespace, and each named import's local name (its ``alias``
    when renamed). Side-effect imports (``import './x'``) have no clause and
    yield no bindings.
    """
    clause = next((c for c in node.children if c.type == "import_clause"), None)
    if clause is None:
        return []
    names: list[str] = []
    for child in clause.children:
        if child.type == "identifier":  # default import
            names.append(child.text.decode())
        elif child.type == "namespace_import":  # * as ns
            ident = next((c for c in child.children if c.type == "identifier"), None)
            if ident is not None:
                names.append(ident.text.decode())
        elif child.type == "named_imports":
            for spec in child.children:
                if spec.type == "import_specifier":
                    name = _ts_specifier_local_name(spec)
                    if name is not None:
                        names.append(name)
    return names


def _ts_reexport_bindings(node: tree_sitter.Node) -> list[str]:
    """Local binding names introduced by a ``export ... from`` re-export.

    ``export * from './x'`` introduces no single named binding and yields none.
    """
    names: list[str] = []
    for child in node.children:
        if child.type == "export_clause":
            for spec in child.children:
                if spec.type == "export_specifier":
                    name = _ts_specifier_local_name(spec)
                    if name is not None:
                        names.append(name)
        elif child.type == "namespace_export":  # export * as ns
            ident = next((c for c in child.children if c.type == "identifier"), None)
            if ident is not None:
                names.append(ident.text.decode())
    return names


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

    # Non-relative imports → external packages
    if not source_text.startswith("."):
        pkg_name = _npm_package_name(source_text)
        external[pkg_name] = package_id("npm", pkg_name)
        return

    # Resolve relative path
    resolved = _resolve_relative_path(file_dir, source_text)

    # Try common extensions
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
            # Map each local binding name (not the file basename) to the file,
            # so call resolution can match the identifier actually used in code.
            for binding in _ts_import_bindings(node):
                result[binding] = candidate
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
        # Bare export (e.g. `export class Foo {}`), not a re-export
        return

    source_text = source_node.text.decode().strip("'\"")

    # Only resolve relative re-exports
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
            for binding in _ts_reexport_bindings(node):
                result[binding] = candidate
            break


# --- path utilities ---


def _parent_dir(path: str) -> str:
    """Get parent directory of a path string."""
    parts = path.rsplit("/", 1)
    return parts[0] if len(parts) > 1 else ""


def _package_submodule_path(resolved_path: str, name: str, known_files: set[str]) -> str | None:
    """Resolve *name* as a submodule of the package *resolved_path* points at.

    Only applies when the import resolved to a package ``__init__.py``;
    returns ``pkg/name.py`` or ``pkg/name/__init__.py`` when known, else None.
    """
    if not resolved_path.endswith("__init__.py"):
        return None
    pkg_dir = resolved_path[: -len("__init__.py")].rstrip("/")
    base = f"{pkg_dir}/{name}" if pkg_dir else name
    for candidate in (f"{base}.py", f"{base}/__init__.py"):
        if candidate in known_files:
            return candidate
    return None


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
