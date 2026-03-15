"""Per-language import analysis using Tree-sitter ASTs.

Parses import statements from already-parsed source files and maps local
aliases to repo-relative file paths, enabling module-qualified call resolution.
"""

from __future__ import annotations

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
            # Try to resolve module.submodule → module/submodule.py or module/submodule/__init__.py
            candidates = _module_to_paths(module_name)
            resolved = False
            for candidate in candidates:
                if candidate in known_files:
                    result[module_name.split(".")[-1]] = candidate
                    resolved = True
                    break
            if not resolved:
                top_level = module_name.split(".")[0]
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
                    if (
                        module_text == module_name_node.text.decode()
                        and module_text.startswith(".")
                    ):
                        module_text = ""
            break

    if is_relative:
        # For relative imports, resolve relative to file's directory
        if module_text:
            base_path = (
                f"{file_dir}/{module_text.replace('.', '/')}"
                if file_dir
                else module_text.replace(".", "/")
            )
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

    # Store individual imported symbol names from `from X import Y, Z`
    if resolved_path is not None:
        for child in node.children:
            if child.type == "dotted_name" and child != node.child_by_field_name(
                "module_name"
            ):
                # Bare imported name: `from X import Y`
                result[child.text.decode()] = resolved_path
            elif child.type == "aliased_import":
                # `from X import Y as Z` — store the alias
                name_node = child.child_by_field_name("name")
                alias_node = child.child_by_field_name("alias")
                if alias_node:
                    result[alias_node.text.decode()] = resolved_path
                elif name_node:
                    result[name_node.text.decode()] = resolved_path
    elif not is_relative:
        # External import: not resolved to any local file
        top_level = module_text.split(".")[0]
        external[top_level] = package_id("pypi", top_level)


def analyze_go_imports(
    root_node: tree_sitter.Node,
    known_files: set[str],
    go_module_path: str | None = None,
) -> ImportResult:
    """Extract Go imports and map package aliases to repo file IDs.

    Handles:
      - ``import "myproject/internal/store"`` → alias "store"
      - ``import s "myproject/internal/store"`` → alias "s"

    Returns:
        ImportResult with internal (alias → file_id) and external (name → pkg ID).
    """
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
    known_files: set[str],
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
    # We check if the last package segment of the import path matches the
    # last directory segment of the known file.
    pkg_name = import_path.rsplit("/", 1)[-1]
    resolved = False
    for known in known_files:
        known_dir = _parent_dir(known)
        # Check: exact match, suffix match, or last segment match
        if (
            known_dir == import_path
            or known_dir.endswith("/" + import_path)
            or known_dir.endswith(import_path)
            or known_dir == pkg_name
            or known_dir.endswith("/" + pkg_name)
        ):
            result[alias] = known
            resolved = True
            break

    if not resolved:
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
            # Alias is the last path segment
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
            alias = source_text.rsplit("/", 1)[-1]
            result[alias] = candidate
            break


# --- path utilities ---


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
