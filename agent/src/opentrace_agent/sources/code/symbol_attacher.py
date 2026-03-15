"""Attaches tree-sitter symbols to file nodes in a repository tree."""

from __future__ import annotations

import logging
from collections import deque
from pathlib import Path
from typing import TYPE_CHECKING, cast

from opentrace_agent.models.base import BaseTreeNode, NodeRelationship
from opentrace_agent.models.nodes import (
    ClassNode,
    DirectoryNode,
    FileNode,
    FunctionNode,
    RepoNode,
)
from opentrace_agent.sources.code.extractors.base import (
    CallRef,
    CodeSymbol,
    SymbolExtractor,
)
from opentrace_agent.sources.code.import_analyzer import (
    analyze_go_imports,
    analyze_python_imports,
    analyze_typescript_imports,
)

if TYPE_CHECKING:
    from opentrace_agent.summarizer.base import Summarizer

logger = logging.getLogger(__name__)


class SymbolAttacher:
    """Walks a ``RepoNode`` tree and attaches parsed symbols to ``FileNode`` leaves.

    Uses a two-phase approach:
      Phase 1 — Extract symbols from all files, build global registries.
      Phase 2 — Resolve call references using a priority-ordered strategy chain.
    """

    def __init__(
        self,
        extractors: list[SymbolExtractor],
        summarizer: Summarizer | None = None,
    ) -> None:
        self._extractors = extractors
        self._summarizer = summarizer

    def attach(self, tree: RepoNode) -> dict[str, int]:
        """BFS-walk *tree*, parse each ``FileNode``, and attach symbol children.

        Returns:
            Counters dict with ``classes``, ``functions``, and ``calls`` totals.
        """
        classes_count = 0
        functions_count = 0

        # Global registries populated during Phase 1
        name_registry: dict[str, list[BaseTreeNode]] = {}
        file_registry: dict[str, dict[str, BaseTreeNode]] = {}
        class_registry: dict[str, list[ClassNode]] = {}
        import_registry: dict[
            str, dict[str, str]
        ] = {}  # file_id → {alias → target_file_id}
        call_info: list[
            tuple[BaseTreeNode, list[CallRef], str]
        ] = []  # (caller, refs, file_id)

        # Collect all file nodes first to build the known_file_ids set
        file_nodes: list[tuple[FileNode, SymbolExtractor]] = []
        dir_nodes: list[DirectoryNode] = []
        queue: deque[BaseTreeNode] = deque([tree])
        while queue:
            node = queue.popleft()
            if isinstance(node, FileNode) and node.abs_path and node.extension:
                extractor = self._find_extractor(node.extension)
                if extractor:
                    file_nodes.append((node, extractor))
            elif isinstance(node, DirectoryNode):
                dir_nodes.append(node)
            for rel in node.children:
                queue.append(rel.target)

        # Build path→file_id mapping for import resolution
        path_to_file_id: dict[str, str] = {}
        for fn, _ in file_nodes:
            if fn.path:
                path_to_file_id[fn.path] = fn.id

        # Pre-compute known_paths once (not per-file)
        known_paths = set(path_to_file_id.keys())

        # Repo gets a static semantic summary (no ML needed)
        tree.summary = f"Source code repository for {tree.name}"

        # Phase 1: Extract & Register (including imports)
        for file_node, extractor in file_nodes:
            c, f = self._process_file(
                file_node,
                extractor,
                name_registry,
                file_registry,
                class_registry,
                call_info,
                import_registry,
                path_to_file_id,
                known_paths,
            )
            classes_count += c
            functions_count += f

        # Phase 2: Resolve calls
        calls_count = _resolve_calls(
            call_info,
            name_registry,
            file_registry,
            class_registry,
            import_registry,
        )

        # Phase 3: Summarize nodes (if summarizer configured)
        summaries_count = 0
        if self._summarizer is not None:
            import asyncio

            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None

            if loop and loop.is_running():
                # Already inside an event loop (e.g. LangGraph) — schedule as a task
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    summaries_count = pool.submit(
                        asyncio.run,
                        self._summarize_nodes(file_nodes, dir_nodes),
                    ).result()
            else:
                summaries_count = asyncio.run(
                    self._summarize_nodes(file_nodes, dir_nodes),
                )

        logger.info(
            "Attached %d classes, %d functions, %d call relationships, %d summaries",
            classes_count,
            functions_count,
            calls_count,
            summaries_count,
        )
        return {
            "classes": classes_count,
            "functions": functions_count,
            "calls": calls_count,
            "summaries": summaries_count,
        }

    def _find_extractor(self, extension: str) -> SymbolExtractor | None:
        for ext in self._extractors:
            if ext.can_handle(extension):
                return ext
        return None

    def _process_file(
        self,
        file_node: FileNode,
        extractor: SymbolExtractor,
        name_registry: dict[str, list[BaseTreeNode]],
        file_registry: dict[str, dict[str, BaseTreeNode]],
        class_registry: dict[str, list[ClassNode]],
        call_info: list[tuple[BaseTreeNode, list[CallRef], str]],
        import_registry: dict[str, dict[str, str]],
        path_to_file_id: dict[str, str],
        known_paths: set[str],
    ) -> tuple[int, int]:
        """Parse a single file and attach symbol nodes. Returns (classes, functions)."""
        try:
            source_bytes = Path(file_node.abs_path).read_bytes()  # type: ignore[arg-type]
        except (OSError, IOError) as exc:
            logger.warning("Could not read %s: %s", file_node.abs_path, exc)
            return 0, 0

        # Use extension-aware extraction for TypeScript
        from opentrace_agent.sources.code.extractors.typescript_extractor import (
            TypeScriptExtractor,
        )

        if isinstance(extractor, TypeScriptExtractor):
            result = extractor.extract_for_extension(
                source_bytes, file_node.extension or ""
            )
        else:
            result = extractor.extract(source_bytes)

        classes = 0
        functions = 0
        file_id = file_node.id
        file_path = file_node.path or ""

        # Ensure file has an entry in file_registry
        if file_id not in file_registry:
            file_registry[file_id] = {}

        # Analyze imports using the SAME root_node from extraction (no re-parse)
        if result.root_node is not None:
            import_result = _analyze_imports_from_node(
                result.root_node,
                result.language,
                file_path,
                known_paths,
            )
            if import_result.internal:
                id_imports: dict[str, str] = {}
                for alias, target_path in import_result.internal.items():
                    target_id = path_to_file_id.get(target_path)
                    if target_id:
                        id_imports[alias] = target_id
                if id_imports:
                    import_registry[file_id] = id_imports

        for symbol in result.symbols:
            child_node, c, f = _symbol_to_node(
                symbol,
                file_id,
                result.language,
                name_registry,
                file_registry,
                class_registry,
                call_info,
            )
            file_node.add_child(
                NodeRelationship(target=child_node, relationship="DEFINED_IN")
            )
            classes += c
            functions += f

        return classes, functions

    async def _summarize_nodes(
        self,
        file_nodes: list[tuple[FileNode, SymbolExtractor]],
        dir_nodes: list[DirectoryNode],
    ) -> int:
        """Phase 3: Generate batched ML summaries for all code nodes.

        Collects all items upfront, then processes in batches for much
        better throughput than sequential calls.
        """
        assert self._summarizer is not None

        try:
            await self._summarizer.init()
        except ImportError:
            logger.warning(
                "Summarization packages not installed — skipping. "
                "Install with: uv pip install opentrace-agent[summarization]"
            )
            return 0
        except Exception:
            logger.warning("Failed to initialize summarizer — skipping", exc_info=True)
            return 0

        from opentrace_agent.summarizer.base import NodeKind

        # Collect all items: (source_text, kind, target_node)
        items: list[
            tuple[str, NodeKind, FileNode | ClassNode | FunctionNode | DirectoryNode]
        ] = []

        # Build dir_path → [child file names] for directory summaries
        dir_child_names: dict[str, list[str]] = {}
        for file_node, _ in file_nodes:
            if not file_node.path:
                continue
            parent_dir = (
                file_node.path.rsplit("/", 1)[0] if "/" in file_node.path else ""
            )
            file_name = file_node.path.rsplit("/", 1)[-1]
            dir_child_names.setdefault(parent_dir, []).append(file_name)

        # Collect file and symbol items
        for file_node, _ in file_nodes:
            if not file_node.abs_path:
                continue

            try:
                source = Path(file_node.abs_path).read_text(errors="replace")
            except OSError:
                continue

            # File item (first ~200 lines)
            file_source = "\n".join(source.splitlines()[:200])
            if file_source.strip():
                items.append((file_source, "file", file_node))

            # Walk children to collect Class and Function nodes
            source_lines = source.splitlines()
            for rel in file_node.children:
                if rel.relationship != "DEFINED_IN":
                    continue
                node = rel.target
                if isinstance(node, (ClassNode, FunctionNode)):
                    snippet = self._extract_snippet(node, source_lines)
                    if snippet:
                        kind: NodeKind = (
                            "class" if isinstance(node, ClassNode) else "function"
                        )
                        items.append((snippet, kind, node))
                    # Also collect methods inside classes
                    if isinstance(node, ClassNode):
                        for child_rel in node.children:
                            if child_rel.relationship == "DEFINED_IN" and isinstance(
                                child_rel.target, FunctionNode
                            ):
                                snippet = self._extract_snippet(
                                    child_rel.target, source_lines
                                )
                                if snippet:
                                    items.append(
                                        (snippet, "function", child_rel.target)
                                    )

        # Collect directory items
        for dn in dir_nodes:
            dir_path = dn.path or dn.name
            children = list(dir_child_names.get(dir_path, []))
            for other in dir_nodes:
                other_path = other.path or other.name
                other_parent = other_path.rsplit("/", 1)[0] if "/" in other_path else ""
                if other_parent == dir_path and other is not dn:
                    children.append(other.name + "/")
            if children:
                listing = f"{dir_path}/ contains: {', '.join(children)}"
                items.append((listing, "directory", dn))

        # Process in batches
        batch_size = (
            self._summarizer._config.batch_size
            if hasattr(self._summarizer, "_config")
            else 8
        )
        count = 0

        for batch_start in range(0, len(items), batch_size):
            batch = items[batch_start : batch_start + batch_size]
            batch_inputs = [(source, kind) for source, kind, _ in batch]

            try:
                summaries = await self._summarizer.summarize_batch(batch_inputs)
            except Exception:
                logger.warning(
                    "Batch summarization failed, falling back to sequential",
                    exc_info=True,
                )
                summaries = []
                for source, kind, _ in batch:
                    try:
                        summaries.append(await self._summarizer.summarize(source, kind))
                    except Exception:
                        summaries.append("")

            for i, (_, _, target_node) in enumerate(batch):
                summary = summaries[i] if i < len(summaries) else ""
                if summary:
                    target_node.summary = summary  # type: ignore[union-attr]
                    count += 1

        return count

    @staticmethod
    def _extract_snippet(
        node: ClassNode | FunctionNode,
        source_lines: list[str],
    ) -> str | None:
        """Extract source lines for a node. Returns None if empty."""
        if node.start_line is None or node.end_line is None:
            return None
        snippet = "\n".join(source_lines[node.start_line - 1 : node.end_line])
        return snippet if snippet.strip() else None


def _symbol_to_node(
    symbol: CodeSymbol,
    parent_id: str,
    language: str,
    name_registry: dict[str, list[BaseTreeNode]],
    file_registry: dict[str, dict[str, BaseTreeNode]],
    class_registry: dict[str, list[ClassNode]],
    call_info: list[tuple[BaseTreeNode, list[CallRef], str]],
) -> tuple[BaseTreeNode, int, int]:
    """Convert a ``CodeSymbol`` to a tree node. Returns (node, classes, functions)."""
    classes = 0
    functions = 0

    # Derive file_id from parent_id (strip any ::suffix to get the file-level id)
    file_id = parent_id.split("::")[0]

    if symbol.kind == "class":
        node = ClassNode(
            id=f"{parent_id}::{symbol.name}",
            name=symbol.name,
            language=language,
            start_line=symbol.start_line,
            end_line=symbol.end_line,
        )
        classes = 1
        name_registry.setdefault(symbol.name, []).append(node)
        file_registry.setdefault(file_id, {})[symbol.name] = node
        class_registry.setdefault(symbol.name, []).append(node)
        # Attach child methods
        for child_sym in symbol.children:
            child_node, c, f = _symbol_to_node(
                child_sym,
                node.id,
                language,
                name_registry,
                file_registry,
                class_registry,
                call_info,
            )
            node.add_child(
                NodeRelationship(target=child_node, relationship="DEFINED_IN")
            )
            classes += c
            functions += f
    else:
        node = FunctionNode(
            id=f"{parent_id}::{symbol.name}",
            name=symbol.name,
            language=language,
            start_line=symbol.start_line,
            end_line=symbol.end_line,
            signature=symbol.signature,
        )
        # Store receiver info for Go method resolution
        if symbol.receiver_var is not None:
            node._receiver_var = symbol.receiver_var  # type: ignore[attr-defined]
        if symbol.receiver_type is not None:
            node._receiver_type = symbol.receiver_type  # type: ignore[attr-defined]
        # Store parameter type hints for type-based resolution
        if symbol.param_types is not None:
            node._param_types = symbol.param_types  # type: ignore[attr-defined]
        functions = 1
        name_registry.setdefault(symbol.name, []).append(node)
        file_registry.setdefault(file_id, {})[symbol.name] = node
        if symbol.calls:
            call_info.append((node, symbol.calls, file_id))

    return node, classes, functions


def _analyze_imports_from_node(
    root_node: object,
    language: str,
    file_path: str,
    known_paths: set[str],
) -> "ImportResult":
    """Run language-specific import analysis using the already-parsed root node.

    Reuses the tree-sitter AST from extraction — no re-parsing needed.
    """
    from opentrace_agent.sources.code.import_analyzer import ImportResult

    if language == "python":
        return analyze_python_imports(root_node, file_path, known_paths)  # type: ignore[arg-type]
    elif language == "go":
        return analyze_go_imports(root_node, known_paths)  # type: ignore[arg-type]
    elif language == "typescript":
        return analyze_typescript_imports(root_node, file_path, known_paths)  # type: ignore[arg-type]
    elif language == "javascript":
        return analyze_typescript_imports(root_node, file_path, known_paths)  # type: ignore[arg-type]
    return ImportResult()


def _resolve_calls(
    call_info: list[tuple[BaseTreeNode, list[CallRef], str]],
    name_registry: dict[str, list[BaseTreeNode]],
    file_registry: dict[str, dict[str, BaseTreeNode]],
    class_registry: dict[str, list[ClassNode]],
    import_registry: dict[str, dict[str, str]] | None = None,
) -> int:
    """Create call relationships from collected call data.

    Applies a priority-ordered resolution chain:
      1. self/this → enclosing class children (confidence 1.0)
      2. Go receiver var → methods with matching receiver_type (confidence 1.0)
      3. ClassName.method() → class_registry lookup (confidence 0.9/1.0)
      4. Import-based resolution → alias maps to target file (confidence 0.9)
      5. Constructor call → bare name matches class in class_registry (confidence per bare rules)
      6. Intra-file bare call (confidence 1.0)
      7. Cross-file bare call with unique match (confidence 0.8)

    Returns count of relationships created.
    """
    total = 0
    for caller_node, call_refs, file_id in call_info:
        seen: set[str] = set()
        for ref in call_refs:
            # Build a dedup key from the full call reference
            dedup_key = f"{ref.receiver or ''}:{ref.name}"
            if dedup_key in seen:
                continue
            if ref.name == caller_node.name and ref.receiver is None:
                continue

            target_node, confidence = _resolve_single_call(
                ref,
                caller_node,
                file_id,
                name_registry,
                file_registry,
                class_registry,
                import_registry or {},
            )
            if target_node is None:
                continue

            seen.add(dedup_key)
            # Append directly — don't use add_child() which would clobber target.parent
            cast(list, caller_node.children).append(
                NodeRelationship(
                    target=target_node,
                    relationship="CALLS",
                    direction="outgoing",
                    confidence=confidence,
                )
            )
            total += 1
    return total


def _resolve_single_call(
    ref: CallRef,
    caller_node: BaseTreeNode,
    file_id: str,
    name_registry: dict[str, list[BaseTreeNode]],
    file_registry: dict[str, dict[str, BaseTreeNode]],
    class_registry: dict[str, list[ClassNode]],
    import_registry: dict[str, dict[str, str]] | None = None,
) -> tuple[BaseTreeNode | None, float]:
    """Try to resolve a single CallRef. Returns (target_node, confidence) or (None, 0)."""

    # Strategy 1: self/this resolution — find method in enclosing class
    if ref.kind == "attribute" and ref.receiver in ("self", "this"):
        class_node = _find_enclosing_class(caller_node)
        if class_node is not None:
            for rel in class_node.children:
                if rel.target.name == ref.name and rel.relationship == "DEFINED_IN":
                    return rel.target, 1.0
        return None, 0.0

    # Strategy 2: Go receiver variable resolution
    if ref.kind == "attribute":
        caller_receiver_var = getattr(caller_node, "_receiver_var", None)
        caller_receiver_type = getattr(caller_node, "_receiver_type", None)
        if (
            caller_receiver_var
            and ref.receiver == caller_receiver_var
            and caller_receiver_type
        ):
            # Look for methods with matching receiver_type
            candidates = name_registry.get(ref.name, [])
            for candidate in candidates:
                if getattr(candidate, "_receiver_type", None) == caller_receiver_type:
                    return candidate, 1.0

    # Strategy 2.5: Parameter type hint resolution (param.method() where param has a known type)
    if ref.kind == "attribute" and ref.receiver:
        param_types = getattr(caller_node, "_param_types", None)
        if param_types:
            type_name = param_types.get(ref.receiver)
            if type_name and type_name in class_registry:
                for cls in class_registry[type_name]:
                    for rel in cls.children:
                        if (
                            rel.target.name == ref.name
                            and rel.relationship == "DEFINED_IN"
                        ):
                            return rel.target, 0.7

    # Strategy 3: ClassName.method() resolution
    if ref.kind == "attribute" and ref.receiver in class_registry:
        class_candidates = class_registry[ref.receiver]
        # Prefer same-file class, then fall back to any
        sorted_classes = sorted(
            class_candidates, key=lambda c: 0 if c.id.split("::")[0] == file_id else 1
        )
        for cls in sorted_classes:
            for rel in cls.children:
                if rel.target.name == ref.name and rel.relationship == "DEFINED_IN":
                    target_file_id = rel.target.id.split("::")[0]
                    conf = 1.0 if target_file_id == file_id else 0.9
                    return rel.target, conf
        # Also check Go-style methods (not class children but have matching receiver_type)
        candidates = name_registry.get(ref.name, [])
        for candidate in candidates:
            if getattr(candidate, "_receiver_type", None) == ref.receiver:
                target_file_id = candidate.id.split("::")[0]
                conf = 1.0 if target_file_id == file_id else 0.9
                return candidate, conf
        return None, 0.0

    # Strategy 4: Import-based resolution — receiver matches an import alias
    if ref.kind == "attribute" and import_registry:
        file_imports = import_registry.get(file_id, {})
        target_file_id = file_imports.get(ref.receiver or "")
        if target_file_id:
            target_names = file_registry.get(target_file_id, {})
            target = target_names.get(ref.name)
            if target is not None:
                return target, 0.9

    # Strategy 4.5: Import-based bare call resolution (from X import Y → Y())
    if ref.kind == "bare" and import_registry:
        file_imports = import_registry.get(file_id, {})
        target_file_id = file_imports.get(ref.name)
        if target_file_id:
            target_names = file_registry.get(target_file_id, {})
            target = target_names.get(ref.name)
            if target is not None:
                # If it's a class, prefer its __init__/constructor
                if isinstance(target, ClassNode):
                    for rel in target.children:
                        if (
                            rel.target.name in ("__init__", "constructor")
                            and rel.relationship == "DEFINED_IN"
                        ):
                            return rel.target, 0.9
                return target, 0.9

    # Strategy 5: Constructor call — bare name matches a class
    if ref.kind == "bare" and ref.name in class_registry:
        class_candidates = class_registry[ref.name]
        # Prefer same-file class, then fall back to any
        sorted_classes = sorted(
            class_candidates, key=lambda c: 0 if c.id.split("::")[0] == file_id else 1
        )
        for cls in sorted_classes:
            # Try to find __init__ or constructor child
            for rel in cls.children:
                if (
                    rel.target.name in ("__init__", "constructor")
                    and rel.relationship == "DEFINED_IN"
                ):
                    target_file_id = rel.target.id.split("::")[0]
                    conf = 1.0 if target_file_id == file_id else 0.8
                    return rel.target, conf
        # Fall back to the class node itself (prefer same-file)
        cls = sorted_classes[0]
        target_file_id = cls.id.split("::")[0]
        conf = 1.0 if target_file_id == file_id else 0.8
        return cls, conf

    # Strategy 6: Intra-file bare call
    if ref.kind == "bare":
        file_names = file_registry.get(file_id, {})
        target = file_names.get(ref.name)
        if target is not None:
            return target, 1.0

    # Strategy 7: Cross-file bare call (unique match only)
    if ref.kind == "bare":
        candidates = name_registry.get(ref.name, [])
        # Filter out same-file candidates (already checked above)
        cross_file = [c for c in candidates if c.id.split("::")[0] != file_id]
        if len(cross_file) == 1:
            return cross_file[0], 0.8

    # Unresolved attribute calls (e.g., fmt.Println, unknown module calls)
    return None, 0.0


def _find_enclosing_class(node: BaseTreeNode) -> ClassNode | None:
    """Walk parent chain to find the nearest enclosing ClassNode."""
    current = node.parent
    while current is not None:
        if isinstance(current, ClassNode):
            return current
        current = current.parent
    return None
