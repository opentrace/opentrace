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

"""MCP server exposing graph query tools against a local LadybugDB database."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import traceback
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from opentrace_agent.store import GraphStore

logger = logging.getLogger(__name__)

MAX_RESULT_CHARS = 32_000  # ~8K tokens; comfortable for subgraphs without
# blowing past LLM context budgets.  Graph subgraphs (search_graph,
# find_usages with deep traversal) regularly exceed 4 KB.

# Relationship types treated as "X depends on Y" for find_usages / impact.
_DEPENDENCY_RELS = frozenset({"CALLS", "IMPORTS", "DEPENDS_ON", "EXTENDS", "IMPLEMENTS"})

# Words to drop from natural-language semantic_search queries before
# searching keyword-by-keyword.  Includes English stopwords plus filler
# nouns the LLM tends to add ("function", "code", "thing") that won't
# match anything useful in symbol names.
_QUERY_STOPWORDS = frozenset(
    {
        # articles / pronouns / aux verbs
        "a",
        "an",
        "the",
        "this",
        "that",
        "these",
        "those",
        "i",
        "you",
        "he",
        "she",
        "it",
        "we",
        "they",
        "me",
        "him",
        "her",
        "us",
        "them",
        "my",
        "your",
        "his",
        "its",
        "our",
        "their",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "do",
        "does",
        "did",
        "doing",
        "done",
        "have",
        "has",
        "had",
        "having",
        "can",
        "could",
        "should",
        "would",
        "may",
        "might",
        "will",
        "shall",
        # prepositions / conjunctions
        "of",
        "in",
        "on",
        "at",
        "to",
        "for",
        "with",
        "without",
        "by",
        "from",
        "as",
        "into",
        "onto",
        "via",
        "about",
        "and",
        "or",
        "but",
        "not",
        "if",
        "then",
        "than",
        "so",
        # interrogatives / instruction verbs
        "what",
        "where",
        "who",
        "when",
        "why",
        "how",
        "which",
        "find",
        "show",
        "get",
        "give",
        "list",
        "tell",
        "explain",
        "search",
        "look",
        "read",
        # common filler nouns the LLM injects
        "function",
        "functions",
        "method",
        "methods",
        "class",
        "classes",
        "code",
        "thing",
        "things",
        "file",
        "files",
        "any",
        "some",
        "all",
        "no",
        "every",
        "each",
        "one",
        "two",
        "use",
        "uses",
        "used",
        "using",
        "handle",
        "handles",
        "handling",
        "handler",
        "handlers",
    }
)


def _tag_match_field(node: dict[str, Any], keywords: list[str]) -> dict[str, Any]:
    """Annotate ``node`` with which field carried the keyword match.

    Why: docstrings can drift from code over time.  A hit on ``name`` or
    ``signature`` is high-confidence — the symbol literally has that
    word.  A hit on ``docs`` only means the comment claims something
    about the symbol; the function body may have been changed since.
    Surface this to the caller so the LLM/user can decide whether to
    trust the result or read source first.

    Sets:
      - ``_match_field``: ``"name"`` | ``"signature"`` | ``"path"`` |
        ``"summary"`` | ``"docs"`` | ``"unknown"``
      - ``_verify``: present only when match was docs-only — a short
        instruction telling the caller to read source before trusting.
    """
    name = (node.get("name") or "").lower()
    props = node.get("properties") or {}
    sig = (props.get("signature") or "").lower()
    path = (props.get("path") or "").lower()
    summary = (props.get("summary") or "").lower()
    docs = (props.get("docs") or "").lower()

    kws = [k.lower() for k in keywords if isinstance(k, str)]

    if any(k in name for k in kws):
        node["_match_field"] = "name"
    elif sig and any(k in sig for k in kws):
        node["_match_field"] = "signature"
    elif path and any(k in path for k in kws):
        node["_match_field"] = "path"
    elif summary and any(k in summary for k in kws):
        node["_match_field"] = "summary"
    elif docs and any(k in docs for k in kws):
        node["_match_field"] = "docs"
        node["_verify"] = (
            "Matched docstring only — the code may be stale relative to the doc. "
            "Read the source via source_read with this node's id to confirm."
        )
    else:
        # FTS may have matched a stemmed form we can't reproduce here.
        node["_match_field"] = "unknown"
    return node


def _extract_query_keywords(query: str) -> list[str]:
    """Pull content tokens out of a natural-language query.

    Lowercases, splits on word boundaries, drops short tokens and
    stopwords, and dedupes while preserving order so the most
    distinctive term in the original phrasing wins ties.
    """
    seen: set[str] = set()
    out: list[str] = []
    for raw in re.findall(r"[A-Za-z][A-Za-z0-9_-]+", query):
        token = raw.lower()
        if len(token) <= 2:
            continue
        if token in _QUERY_STOPWORDS:
            continue
        if token in seen:
            continue
        seen.add(token)
        out.append(token)
    return out


def _truncate(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[truncated, {len(text)} chars total]"


def _json_response(data: Any) -> str:
    return _truncate(json.dumps(data, default=str))


def _error_response(tool_name: str, e: Exception) -> str:
    tb = traceback.format_exception(e)
    logger.error("Error executing tool %s: %s\n%s", tool_name, e, "".join(tb))
    return json.dumps({"error": f"{type(e).__name__}: {e}"})


NO_INDEX_MSG = json.dumps(
    {
        "status": "ok",
        "message": "No index available. Run 'opentraceai index' to create one.",
    }
)


def _repo_paths(store: GraphStore) -> list[tuple[str, str]]:
    """Return ``[(repo_id, abs_path), ...]`` from index metadata.

    Only entries with both fields are returned.  Used by tools that need
    filesystem access (``source_read``, ``source_grep``).
    """
    try:
        entries = store.get_metadata()
    except Exception:
        return []
    out: list[tuple[str, str]] = []
    for entry in entries:
        repo_id = entry.get("repoId") or entry.get("repo_id")
        repo_path = entry.get("repoPath") or entry.get("repo_path")
        if isinstance(repo_id, str) and isinstance(repo_path, str):
            out.append((repo_id, repo_path))
    return out


def _repo_from_node_id(node_id: str) -> str:
    """Extract the repo prefix from a node ID like ``repo/path/file.py::Sym``."""
    slash = node_id.find("/")
    return node_id if slash == -1 else node_id[:slash]


def _read_file_slice(abs_path: str, start_line: int | None, end_line: int | None) -> str:
    """Read a file (optionally line-sliced) and return ``cat -n``-style output."""
    p = Path(abs_path)
    if p.is_dir():
        try:
            entries = sorted(os.listdir(abs_path))[:50]
        except OSError as e:
            return f"[Could not list directory {abs_path}: {e}]"
        return (
            f"[Directory: {abs_path}]\nContents: {', '.join(entries)}\n\n"
            "Use source_grep to find specific files, or source_read with a full file path."
        )
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return f"[Could not read {abs_path}: {e}]"

    if start_line is None and end_line is None:
        return content

    lines = content.split("\n")
    start = max(0, (start_line or 1) - 1)
    end = end_line if end_line is not None else len(lines)
    sliced = lines[start:end]
    header = f"// {abs_path}:{start_line or 1}-{end}\n"
    body = "\n".join(f"{start + i + 1}\t{line}" for i, line in enumerate(sliced))
    return header + body


def create_mcp_server(
    store: GraphStore | None,
    *,
    db_path: str | None = None,
) -> FastMCP:
    """Create a FastMCP server with graph query tools backed by *store*.

    When *store* is ``None`` (no database found), every tool returns a
    friendly "no index" response instead of raising an error.

    *db_path* is used by ``repo_index`` to direct the indexer at the same
    database the server is reading from.  When omitted, ``repo_index``
    creates a fresh database under the target path.
    """
    server = FastMCP("opentrace")

    @server.tool()
    def search_graph(query: str, hops: int = 2, limit: int = 20) -> str:
        """Search the graph and return a SUBGRAPH around the matches.

        Finds nodes matching ``query`` (keyword), then expands
        ``hops`` levels of neighbors via BFS over RELATES edges.
        Returns ``{"nodes": [...], "relationships": [...]}`` — both
        the nodes and the edges connecting them, so the caller can
        understand the local network around each match without further
        ``traverse_graph`` calls.

        Use this when the question is structural: "what does X connect
        to?", "show me the area of the graph around Y".  Use
        ``keyword_search`` when you only want a flat list of matches.

        ``hops`` is capped at 5; ``limit`` (initial seed nodes) is
        capped at 200.
        """
        if not store:
            logger.info("search_graph called but no index exists")
            return NO_INDEX_MSG
        logger.debug("search_graph(query=%r, hops=%d, limit=%d)", query, hops, limit)
        try:
            hops = max(0, min(hops, 5))
            limit = max(1, min(limit, 200))
            nodes, relationships = store.search_graph(query, hops=hops, limit=limit)
            return _json_response(
                {
                    "nodes": nodes,
                    "relationships": relationships,
                    "summary": {
                        "node_count": len(nodes),
                        "relationship_count": len(relationships),
                        "hops": hops,
                    },
                }
            )
        except Exception as e:
            return _error_response("search_graph", e)

    @server.tool()
    def list_nodes(type: str, limit: int = 50, filters: dict[str, Any] | None = None) -> str:
        """List nodes of a specific type.

        Valid types include: Repository, Class, Function, File, Directory,
        Package, Module, Service, Endpoint, Database.
        """
        if not store:
            logger.info("list_nodes called but no index exists")
            return NO_INDEX_MSG
        logger.debug("list_nodes(type=%r, limit=%d, filters=%r)", type, limit, filters)
        try:
            limit = min(limit, 1000)
            nodes = store.list_nodes(node_type=type, filters=filters, limit=limit)
            logger.debug("list_nodes → %d results", len(nodes))
            return _json_response(nodes)
        except Exception as e:
            return _error_response("list_nodes", e)

    @server.tool()
    def get_node(nodeId: str) -> str:
        """Get full details of a single node by its ID, including all properties and immediate neighbors."""
        if not store:
            logger.info("get_node called but no index exists")
            return NO_INDEX_MSG
        logger.debug("get_node(nodeId=%r)", nodeId)
        try:
            node = store.get_node(nodeId)
            if node is None:
                return json.dumps({"error": f"Node not found: {nodeId}"})

            try:
                neighbors = store.traverse(nodeId, direction="both", max_depth=1)
            except ValueError:
                neighbors = []
            result = {
                "node": node,
                "neighbors": [{"node": n["node"], "relationship": n["relationship"]} for n in neighbors],
            }
            return _json_response(result)
        except Exception as e:
            return _error_response("get_node", e)

    @server.tool()
    def traverse_graph(
        nodeId: str,
        depth: int = 3,
        direction: str = "outgoing",
        relationship: str = "",
    ) -> str:
        """Walk relationships from a starting node.

        Direction can be 'outgoing', 'incoming', or 'both'.
        Optionally filter by relationship type (e.g. 'CALLS', 'DEFINES', 'CONTAINS').
        """
        if not store:
            logger.info("traverse_graph called but no index exists")
            return NO_INDEX_MSG
        logger.debug(
            "traverse_graph(nodeId=%r, depth=%d, direction=%r, relationship=%r)",
            nodeId,
            depth,
            direction,
            relationship,
        )
        try:
            if direction not in ("outgoing", "incoming", "both"):
                return json.dumps(
                    {"error": f"Invalid direction: {direction}. Must be 'outgoing', 'incoming', or 'both'."}
                )
            depth = min(depth, 10)
            rel_type = relationship if relationship else None
            results = store.traverse(
                nodeId,
                direction=direction,
                max_depth=depth,
                relationship_type=rel_type,
            )
            return _json_response(results)
        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            return _error_response("traverse_graph", e)

    @server.tool()
    def get_stats() -> str:
        """Get graph statistics: total node count, total edge count, and node counts broken down by type.

        Use this as a first step to understand what has been indexed before running targeted queries.
        """
        if not store:
            logger.info("get_stats called but no index exists")
            return NO_INDEX_MSG
        logger.debug("get_stats()")
        try:
            stats = store.get_stats()
            logger.debug("get_stats → %d nodes, %d edges", stats["total_nodes"], stats["total_edges"])
            return _json_response(stats)
        except Exception as e:
            return _error_response("get_stats", e)

    # -------------------------------------------------------------------
    # keyword_search — tokenized multi-keyword search.  Honest naming:
    # this is *not* semantic / vector search.  Embeddings are a future
    # addition; today this is FTS (when the extension is available) plus
    # substring fallback against name + search_text.
    # -------------------------------------------------------------------
    @server.tool()
    def keyword_search(query: str, nodeTypes: str = "", limit: int = 10) -> str:
        """Search the graph by keyword(s) — works with multi-word phrases.

        Tokenizes the query (drops stopwords and filler nouns like
        "function" / "code" / "handle"), runs a search per remaining
        keyword, merges results, and ranks by how many keywords each
        node hit.  Use this when the user phrases their query as a
        sentence ("functions that validate user input", "code that
        handles auth tokens"); use ``search_graph`` when the user gives
        a single literal symbol name.

        Each result is tagged with:
        - ``_match_count``  — how many of the query's keywords it hit
        - ``_matched``      — the specific keywords that matched
        - ``_match_field``  — which field carried the match
                              (``"name"`` is high-confidence; ``"docs"``
                              means the docstring matched but the code
                              may be stale — read source to confirm)
        - ``_verify``       — present when match was docs-only,
                              telling the caller to verify

        Caveat: this is keyword search, not semantic search.  Vector
        embeddings are planned but not yet implemented.  Run
        ``opentraceai augment`` to enrich nodes with LLM-generated
        summaries — they're folded into ``search_text`` and improve
        keyword recall on natural-language queries.
        """
        if not store:
            logger.info("keyword_search called but no index exists")
            return NO_INDEX_MSG
        logger.debug("keyword_search(query=%r, limit=%d, nodeTypes=%r)", query, limit, nodeTypes)
        try:
            types = [t.strip() for t in nodeTypes.split(",") if t.strip()] or None
            limit = max(1, min(limit, 1000))

            keywords = _extract_query_keywords(query)
            if not keywords:
                # Single token, all stopwords, or punctuation only — pass
                # through unchanged so a one-word query still works.
                nodes = store.search_nodes(query, node_types=types, limit=limit)
                tagged = [_tag_match_field(n, [query]) for n in nodes]
                return _json_response(tagged)

            # Search per keyword, then merge.  Per-keyword limit is
            # generous so ranking still has signal when one keyword
            # matches widely.
            per_kw_limit = max(limit * 3, 30)
            scored: dict[str, dict[str, Any]] = {}
            for kw in keywords:
                try:
                    matches = store.search_nodes(kw, node_types=types, limit=per_kw_limit)
                except Exception:
                    continue
                for node in matches:
                    nid = node.get("id")
                    if not nid:
                        continue
                    entry = scored.get(nid)
                    if entry is None:
                        scored[nid] = {**node, "_match_count": 1, "_matched": [kw]}
                    else:
                        entry["_match_count"] += 1
                        entry["_matched"].append(kw)

            if not scored:
                return _json_response([])

            ranked = sorted(
                scored.values(),
                key=lambda n: (-n["_match_count"], n.get("name", "")),
            )
            tagged = [_tag_match_field(n, n["_matched"]) for n in ranked[:limit]]
            return _json_response(tagged)
        except Exception as e:
            return _error_response("keyword_search", e)

    # -------------------------------------------------------------------
    # source_read — read source from any indexed repo (avoids permission
    # prompts the agent harness raises for files outside the project).
    # -------------------------------------------------------------------
    @server.tool()
    def source_read(
        nodeId: str = "",
        path: str = "",
        repo: str = "",
        startLine: int = 0,
        endLine: int = 0,
    ) -> str:
        """Read source code from any indexed repository.

        Provide either ``nodeId`` (preferred — looked up via the graph to
        recover its file path and line range) or a ``path`` relative to a
        repo root (with optional ``repo`` to disambiguate).  ``startLine`` /
        ``endLine`` clip the returned slice; leave 0 to read the whole file.
        Returns ``cat -n``-style numbered output.
        """
        if not store:
            return NO_INDEX_MSG
        logger.debug(
            "source_read(nodeId=%r, path=%r, repo=%r, lines=%d-%d)",
            nodeId,
            path,
            repo,
            startLine,
            endLine,
        )
        try:
            file_path: str | None = None
            repo_hint: str | None = repo or None
            start = startLine or None
            end = endLine or None

            if nodeId:
                node = store.get_node(nodeId)
                if node is None:
                    return json.dumps({"error": f"Node not found: {nodeId}"})
                props = node.get("properties") or {}
                file_path = props.get("path")
                if start is None:
                    start = props.get("start_line") or props.get("startLine")
                if end is None:
                    end = props.get("end_line") or props.get("endLine")

                if not file_path:
                    # Fall back to the node ID itself: ``repo/path/file::Sym``.
                    nid = nodeId
                    dc = nid.find("::")
                    path_part = nid[:dc] if dc != -1 else nid
                    slash = path_part.find("/")
                    if slash != -1:
                        repo_hint = repo_hint or path_part[:slash]
                        file_path = path_part[slash + 1 :]
                    else:
                        file_path = path_part
            else:
                file_path = path or None

            if not file_path:
                return json.dumps({"error": "Provide either nodeId or path"})

            repos = _repo_paths(store)
            candidates: list[str] = []
            if repo_hint:
                for rid, abs_path in repos:
                    if rid == repo_hint:
                        candidates.append(os.path.join(abs_path, file_path))
                        break
            for _, abs_path in repos:
                joined = os.path.join(abs_path, file_path)
                if joined not in candidates:
                    candidates.append(joined)

            for candidate in candidates:
                if os.path.exists(candidate):
                    return _truncate(_read_file_slice(candidate, start, end))

            return json.dumps({"error": f"Source file not found: {file_path}"})
        except Exception as e:
            return _error_response("source_read", e)

    # -------------------------------------------------------------------
    # source_grep — ripgrep across all indexed repository checkouts.
    # -------------------------------------------------------------------
    @server.tool()
    def source_grep(pattern: str, repo: str = "", include: str = "", limit: int = 50) -> str:
        """Regex-search file contents across every indexed repository.

        Like ``rg``, but driven from the index's metadata so the tool knows
        every checkout's location.  ``repo`` filters to a single repo by
        substring match; ``include`` is a glob filter (e.g. ``*.py``).
        Output paths are repo-relative and tagged with ``[repoId]``.
        Requires ``rg`` on PATH.
        """
        if not store:
            return NO_INDEX_MSG
        rg = shutil.which("rg")
        if not rg:
            return json.dumps({"error": "ripgrep (rg) not found on PATH"})

        repos = _repo_paths(store)
        if not repos:
            return json.dumps({"error": "No indexed repository paths available"})

        if repo:
            needle = repo.lower()
            repos = [r for r in repos if needle in r[0].lower()]
            if not repos:
                return json.dumps({"error": f"No indexed repo matching {repo!r}"})

        try:
            limit = max(1, min(limit, 1000))
            results: list[str] = []
            total = 0
            for repo_id, abs_path in repos:
                cmd = [rg, "--no-heading", "--line-number", "--max-count", str(limit)]
                if include:
                    cmd.extend(["--glob", include])
                cmd.extend([pattern, abs_path])
                try:
                    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15, check=False)
                except subprocess.TimeoutExpired:
                    continue
                if proc.stdout:
                    for line in proc.stdout.splitlines():
                        # Strip the absolute repo path prefix so the LLM sees
                        # repo-relative paths only.
                        rel = line[len(abs_path) + 1 :] if line.startswith(abs_path) else line
                        results.append(f"[{repo_id}] {rel}")
                        total += 1
                        if total >= limit:
                            break
                if total >= limit:
                    break

            if not results:
                return json.dumps({"matches": [], "message": f"No matches for {pattern!r} in {len(repos)} repo(s)"})
            return _truncate("\n".join(results))
        except Exception as e:
            return _error_response("source_grep", e)

    # -------------------------------------------------------------------
    # find_usages — incoming dependency edges of the best symbol match.
    # -------------------------------------------------------------------
    @server.tool()
    def find_usages(symbol: str, type: str = "", depth: int = 2) -> str:
        """Find callers, importers, and dependents of a symbol.

        Searches the graph for the named symbol, picks the highest-ranked
        match, then walks *incoming* CALLS / IMPORTS / DEPENDS_ON /
        EXTENDS / IMPLEMENTS edges up to ``depth`` hops (capped at 5).
        Returns the target node and a list of dependents.

        Depth semantics:
          - ``depth=1`` → only **direct** usages (functions that
            literally call / import the target).
          - ``depth=2`` (default) and higher → **transitive** usages —
            callers of callers.  This grows quickly; if you only want
            the immediate ring, pass ``depth=1`` explicitly.

        Coverage caveat: only edges in the indexed graph are visible.
        Callers in repos that haven't been indexed are not counted.
        Use ``repo_index`` to widen coverage before relying on this for
        change-safety decisions.
        """
        if not store:
            return NO_INDEX_MSG
        logger.debug("find_usages(symbol=%r, type=%r, depth=%d)", symbol, type, depth)
        try:
            depth = max(1, min(depth, 5))
            types = [type] if type else None
            matches = store.search_nodes(symbol, node_types=types, limit=5)
            if not matches:
                return json.dumps({"error": f"No node matching {symbol!r}" + (f" of type {type}" if type else "")})

            target = matches[0]
            deps = store.traverse(target["id"], direction="incoming", max_depth=depth)
            relevant = [d for d in deps if d["relationship"]["type"] in _DEPENDENCY_RELS]

            return _json_response(
                {
                    "target": target,
                    "dependents": relevant,
                    "count": len(relevant),
                    "candidates": [{"id": m["id"], "name": m["name"], "type": m["type"]} for m in matches],
                }
            )
        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            return _error_response("find_usages", e)

    # -------------------------------------------------------------------
    # impact_analysis — blast radius of edits to a file.
    # -------------------------------------------------------------------
    @server.tool()
    def impact_analysis(target: str, lines: str = "") -> str:
        """Show the blast radius of changes to a file.

        Locates the File node matching ``target`` (full or partial
        path), finds symbols defined in it, and walks incoming
        dependency edges for each symbol.  ``lines`` narrows analysis
        to ranges like ``"10-25,40-60"``.  Returns a structured summary
        the model can show directly to the user before they make a
        change.

        Coverage caveat: blast radius is bounded by what's been indexed.
        Dependents living in un-indexed repos are invisible — you may
        get a "no dependents found" result that's wrong in the larger
        codebase.  Run ``repo_index`` on every repo that could plausibly
        depend on the target before treating a clean result as
        change-safe.
        """
        if not store:
            return NO_INDEX_MSG
        logger.debug("impact_analysis(target=%r, lines=%r)", target, lines)
        try:
            line_ranges: list[tuple[int, int]] | None = None
            if lines:
                line_ranges = []
                for part in lines.split(","):
                    part = part.strip()
                    if not part:
                        continue
                    try:
                        if "-" in part:
                            lo, hi = part.split("-", 1)
                            line_ranges.append((int(lo), int(hi)))
                        else:
                            n = int(part)
                            line_ranges.append((n, n))
                    except ValueError:
                        continue

            file_nodes = store.search_nodes(target, node_types=["File"], limit=5)
            if not file_nodes:
                bn = os.path.basename(target)
                if bn and bn != target:
                    file_nodes = store.search_nodes(bn, node_types=["File"], limit=5)
            if not file_nodes:
                return json.dumps({"error": f"File not found in index: {target}"})

            # Prefer an exact path-suffix match over the FTS top result.
            file_node = file_nodes[0]
            for fn in file_nodes:
                node_path = (fn.get("properties") or {}).get("path", "")
                if node_path.endswith(target) or target.endswith(node_path):
                    file_node = fn
                    break

            symbols_with_deps: list[dict[str, Any]] = []
            for nb_node, _rel in store._get_neighbors(file_node["id"], "incoming"):
                if nb_node["type"] not in ("Function", "Class", "Module"):
                    continue
                if line_ranges:
                    props = nb_node.get("properties") or {}
                    sl = props.get("start_line")
                    el = props.get("end_line") or sl
                    if sl is not None:
                        sl_i = int(sl)
                        el_i = int(el)
                        if not any(sl_i <= hi and el_i >= lo for lo, hi in line_ranges):
                            continue
                try:
                    deps = store.traverse(nb_node["id"], direction="incoming", max_depth=2)
                except ValueError:
                    deps = []
                relevant = [d for d in deps if d["relationship"]["type"] in _DEPENDENCY_RELS]
                symbols_with_deps.append({"symbol": nb_node, "dependents": relevant, "count": len(relevant)})

            total = sum(s["count"] for s in symbols_with_deps)
            return _json_response(
                {
                    "file": file_node,
                    "symbols": symbols_with_deps,
                    "total_dependents": total,
                }
            )
        except Exception as e:
            return _error_response("impact_analysis", e)

    # -------------------------------------------------------------------
    # repo_index — index a local path or remote git URL.
    # -------------------------------------------------------------------
    @server.tool()
    def repo_index(path_or_url: str, repoId: str = "", ref: str = "") -> str:
        """Index a local directory or remote git URL into the graph.

        - **Local path**: shells out to ``opentraceai index <path>`` against
          the running server's database, or creates a fresh one when no
          DB is known.
        - **Git URL** (``https://``, ``http://`` or ``git@``): shells out
          to ``opentraceai fetch-and-index <url>``, which clones to
          ``~/.opentrace/repos/{org}/{name}`` and indexes from there.
          Only public repositories are supported in the open-source build.

        After the subprocess exits, the server hot-reloads automatically.
        """
        is_url = (
            path_or_url.startswith("https://") or path_or_url.startswith("http://") or path_or_url.startswith("git@")
        )

        if is_url:
            cmd = ["opentraceai", "fetch-and-index", path_or_url]
            if repoId:
                cmd.extend(["--repo-id", repoId])
            if ref:
                cmd.extend(["--ref", ref])
            if db_path:
                cmd.extend(["--db", db_path])
        else:
            try:
                target = Path(path_or_url).expanduser().resolve()
            except Exception as e:
                return json.dumps({"error": f"Invalid path: {e}"})
            if not target.exists():
                return json.dumps({"error": f"Path does not exist: {target}"})
            if not target.is_dir():
                return json.dumps({"error": f"Path is not a directory: {target}"})

            cmd = ["opentraceai", "index", str(target)]
            if db_path:
                cmd.extend(["--db", db_path])
            if repoId:
                cmd.extend(["--repo-id", repoId])

        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
        except FileNotFoundError:
            return json.dumps({"error": "opentraceai not found on PATH — install with `pip install opentraceai`"})
        except subprocess.TimeoutExpired:
            return json.dumps({"error": "Indexing timed out after 10 minutes"})

        return _json_response(
            {
                "exit_code": proc.returncode,
                "stdout": proc.stdout[-2000:],
                "stderr": proc.stderr[-2000:] if proc.stderr else "",
            }
        )

    return server
