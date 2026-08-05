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
import re
import traceback
from typing import Any

from mcp.server.fastmcp import FastMCP

from opentrace_agent.retrieval import (
    count_by as _count_by,
)
from opentrace_agent.retrieval import (
    find_communities_spanning_domains as _find_communities_spanning_domains,
)
from opentrace_agent.retrieval import (
    find_orphans as _find_orphans,
)
from opentrace_agent.retrieval import (
    find_path as _find_path,
)
from opentrace_agent.retrieval import (
    find_via_relationship_to_type as _find_via_relationship_to_type,
)
from opentrace_agent.retrieval import (
    grep as _grep,
)
from opentrace_agent.retrieval import (
    overview as _overview,
)
from opentrace_agent.retrieval import (
    provenance as _provenance,
)
from opentrace_agent.retrieval import (
    search as _search,
)
from opentrace_agent.retrieval.communities import (
    cross_community_bridges as _cross_community_bridges,
)
from opentrace_agent.retrieval.communities import (
    god_nodes as _god_nodes,
)
from opentrace_agent.retrieval.communities import (
    list_communities as _list_communities,
)
from opentrace_agent.store import GraphStore

logger = logging.getLogger(__name__)

MAX_RESULT_CHARS = 4000
# List-shaped enumeration responses get a larger budget than the general cap:
# their whole value is completeness, so trading bytes for a complete set is the
# right trade. Used by list_nodes and grep alike.
MAX_LIST_RESULT_CHARS = 20000
_GREP_SNIPPET_CHARS = 100  # per-line snippet when a full-text grep response won't fit
NODE_TYPE_KNOWLEDGE_DOC_NAME = "KnowledgeDoc"


def _truncate(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[truncated, {len(text)} chars total]"


def _json_response(data: Any) -> str:
    """Serialize a tool result, keeping it parseable when it must be shortened.

    An oversized list is shortened by dropping whole ITEMS into the shared
    ``{items, returned, offset, hasMore, hint}`` window (see
    :func:`_json_list_window`), so the agent gets valid JSON plus an explicit
    signal that its view is partial. String-slicing a JSON document — the old
    behaviour, still the fallback for non-list payloads — cuts mid-token: 25
    KnowledgeDocs serialized to 21,586 chars, got sliced at 4,000, and the
    agent received a ``JSONDecodeError`` instead of a partial answer."""
    text = json.dumps(data, default=str)
    if len(text) <= MAX_RESULT_CHARS:
        return text
    if isinstance(data, list):
        return _json_list_window(data, offset=0, more=False, budget=MAX_RESULT_CHARS)
    if isinstance(data, dict):
        shrunk = _shrink_dominant_list(data, MAX_RESULT_CHARS)
        if shrunk is not None:
            return shrunk
    return json.dumps(
        {
            "truncated": True,
            "totalChars": len(text),
            "hint": (
                "payload too large to return whole; narrow the request (lower limit, add filters, or use a lineRange)"
            ),
            "head": text[: max(0, MAX_RESULT_CHARS - 400)],
        }
    )


def _shrink_dominant_list(data: dict[str, Any], budget: int) -> str | None:
    """Shrink a dict payload by dropping entries from its largest list field.

    Returns the serialized JSON, or ``None`` when the dict holds no list worth
    shedding (caller then falls back to the string-head envelope).

    This is the fix for the most common corruption in practice: ``search_graph``
    returns ``{hits, count, query}`` and ``get_node`` returns ``{node,
    neighbours}`` — both dicts, so both previously fell through to
    string-slicing. Measured on one 15-question benchmark run, **39% of
    search_graph results and 78% of get_node results reached the agent as
    unparseable JSON**, which is what drove it to re-issue the same query in
    slightly different words over and over."""
    list_keys = [k for k, v in data.items() if isinstance(v, list) and v]
    if not list_keys:
        return None
    key = max(list_keys, key=lambda k: len(json.dumps(data[k], default=str)))
    items = data[key]
    kept = list(items)
    while kept:
        kept.pop()
        payload = {**data, key: kept}
        dropped = len(items) - len(kept)
        payload["returned"] = len(kept)
        payload["total"] = len(items)
        payload["hasMore"] = True
        payload["hint"] = (
            f"{dropped} of {len(items)} {key} omitted to fit the response cap — narrow the request to see the rest"
        )
        if isinstance(data.get("count"), int):
            payload["count"] = len(kept)
        text = json.dumps(payload, default=str)
        if len(text) <= budget:
            return text
    return None


def _fit_grep_response(result: dict[str, Any], budget: int = MAX_LIST_RESULT_CHARS) -> str:
    """Serialize a grep result, degrading LINE DETAIL but never dropping documents.

    grep is the exhaustiveness primitive: the answer to "which documents
    discuss X" is the document SET, and every line is supporting detail. The
    generic truncation path optimises for the opposite — it sheds whole list
    entries, which for grep means shedding documents.

    Measured consequence: a sweep matched 39 lines across 18 documents, the
    4 KB cap kept 8 and dropped the rest, and the arm — reading `count: 8` and
    a hint advising it to "narrow the request" — concluded no such constraint
    existed. The evidence had been retrieved and then discarded in transport,
    and the advice to narrow made it worse, since each narrowed sweep is a
    different biased sample of the corpus.

    Grouping by document also removes the redundancy that caused the overflow:
    `node_id`, `title`, `status` and `structural_context` were repeated on
    every match rather than stated once per document.

    Budget is ``MAX_LIST_RESULT_CHARS``, not the general cap: this is a
    list-shaped enumeration response, exactly like ``list_nodes``, which has
    had the larger budget all along. Running grep on the small cap is what
    forced the degradation below to fire on a routine 31-document sweep.

    Degradation ladder, applied only as needed. ``node_id`` and ``path`` are
    NEVER dropped — an entry the agent cannot pass to ``load_source`` is a
    result it cannot act on, which is worse than a shorter list. (Learned the
    hard way: an earlier ladder shed ``node_id`` first, and the arm answered a
    31-document sweep with 3 reads because nothing in the response was
    addressable.)
      0. + title, status, full line text
      1. + title, status, line snippets (first 100 chars)
      2. + title, status, line numbers only
      3. + status, per-document match count
      4. per-document match count
      5. documents trimmed, with an explicit ``hasMore`` + omitted count
    """
    if result.get("mode") == "error" or not result.get("matches"):
        return _json_response(result)

    by_doc: dict[str, dict[str, Any]] = {}
    for m in result["matches"]:
        key = m.get("node_id") or m.get("file_path") or ""
        doc = by_doc.setdefault(
            key,
            {
                "node_id": m.get("node_id"),
                "path": m.get("file_path"),
                "title": m.get("title"),
                "status": m.get("status"),
                "lines": [],
            },
        )
        doc["lines"].append({"line": m.get("line_number"), "text": m.get("line_text")})

    docs = [{k: v for k, v in d.items() if v is not None} for d in by_doc.values()]
    base = {
        "scope": result.get("scope"),
        "mode": result.get("mode"),
        "matched_documents": len(docs),
        "total_matches": result.get("count"),
    }

    def _payload(level: int) -> dict[str, Any]:
        out = dict(base)
        shaped = []
        for d in docs:
            e = {k: d[k] for k in ("node_id", "path") if k in d}
            if level <= 2 and "title" in d:
                e["title"] = d["title"]
            if level <= 3 and "status" in d:
                e["status"] = d["status"]
            if level == 0:
                e["lines"] = d["lines"]
            elif level == 1:
                # Snippets: enough to judge relevance without the full line.
                e["lines"] = [
                    {"line": ln["line"], "text": (ln["text"] or "")[:_GREP_SNIPPET_CHARS]} for ln in d["lines"]
                ]
            elif level == 2:
                e["lines"] = [ln["line"] for ln in d["lines"]]
            else:
                e["match_count"] = len(d["lines"])
            shaped.append(e)
        out["documents"] = shaped
        detail = {
            1: "line text shortened to snippets to fit the response cap; every matched document is listed",
            2: "line text omitted (line numbers kept) to fit the response cap; every matched document is listed",
            3: "line detail and titles omitted to fit the response cap; every matched document is listed",
            4: "match counts only to fit the response cap; every matched document is listed",
        }.get(level)
        if detail:
            out["detail"] = detail
        return out

    for level in (0, 1, 2, 3, 4):
        text = json.dumps(_payload(level), default=str)
        if len(text) <= budget:
            return text
    # Even id+path+count for every document overflowed. Only now trim the
    # document list, and say so — a silently short set is the one outcome an
    # exhaustiveness tool must never produce.
    entries = _payload(4)["documents"]
    kept = list(entries)
    while kept:
        kept.pop()
        payload = dict(base)
        payload["documents"] = kept
        payload["returned_documents"] = len(kept)
        payload["hasMore"] = True
        payload["detail"] = (
            f"{len(entries) - len(kept)} of {len(entries)} matched documents omitted to fit the "
            "response cap — narrow with fileFilter, or treat this set as INCOMPLETE"
        )
        text = json.dumps(payload, default=str)
        if len(text) <= budget:
            return text
    return json.dumps({**base, "documents": [], "hasMore": True, "detail": "response cap too small"})


def _population_note(store: GraphStore, node_type: str, edge_type: str) -> dict[str, Any]:
    """Describe the set an existence/absence answer was computed over.

    Absence claims are only as good as their population. This makes the
    boundary explicit at the point of use rather than leaving the caller to
    assume the graph covers everything on disk.
    """
    try:
        population = len(store.list_nodes(node_type=node_type, limit=100_000))
    except Exception:
        population = None
    note: dict[str, Any] = {
        "nodeType": node_type,
        "edgeType": edge_type,
        "population": population,
        "meaning": (
            f"computed over the {population if population is not None else '?'} {node_type} "
            "node(s) in this graph, not over the filesystem"
        ),
    }
    if node_type == NODE_TYPE_KNOWLEDGE_DOC_NAME:
        note["caveat"] = (
            "KnowledgeDocs cover only files the doc pass ingested — other extensions and "
            "empty/low-content files are absent, and byte-identical files share ONE node "
            "(see its `paths`). A document can therefore look unlinked because the "
            "document that links to it is not in the graph. Confirm an absence claim "
            "against the files with grep before asserting it."
        )
    return note


def _error_response(tool_name: str, e: Exception) -> str:
    tb = traceback.format_exception(e)
    logger.error("Error executing tool %s: %s\n%s", tool_name, e, "".join(tb))
    return json.dumps({"error": f"{type(e).__name__}: {e}"})


def _neighbour_summary(node: dict[str, Any]) -> str:
    """Return a short, agent-legible summary for a neighbour node.

    Prefer ``one_line_summary`` (set on KnowledgeDoc by the wiki ingest pipeline);
    fall back to truncated ``summary`` (set on code nodes by the indexer);
    fall back to the node ``name``.
    """
    props = node.get("properties") or {}
    one_line = props.get("one_line_summary")
    if isinstance(one_line, str) and one_line.strip():
        return one_line.strip()
    summary = props.get("summary")
    if isinstance(summary, str) and summary.strip():
        text = summary.strip()
        return text if len(text) <= 200 else text[:197] + "..."
    return str(node.get("name") or node.get("id") or "")


NO_INDEX_MSG = json.dumps(
    {
        "status": "ok",
        "message": "No index available. Run 'opentraceai index' to create one.",
    }
)

# Document bodies legitimately exceed the 4 KB tool-response cap that
# ``_json_response`` applies to structured results. We still bound them so a
# pathological multi-MB file can't blow the response budget; an agent that
# needs more should request a narrower line range.
# ONE cap for every body read, whichever node type you came in through.
# These were 200_000 (File → disk) and 40_000 (KnowledgeDoc → corpus), so the
# same 90 KB document returned 2.26x more text via its File twin than via its
# KnowledgeDoc. That asymmetry is invisible to the caller and it decided a
# benchmark question: reading DOCS.md whole, one arm saw the two /conflicts
# routes that only appear there; the arm on the doc path read it in slices and
# reported the discrepancy as absent. A doc layer must never see less of a
# document than the code layer does.
MAX_SOURCE_BODY_CHARS = 40_000


def _props(node: dict[str, Any]) -> dict[str, Any]:
    """Return a node's properties as a dict, tolerating a JSON-string column."""
    p = node.get("properties") or {}
    if isinstance(p, str):
        try:
            return json.loads(p)
        except Exception:
            return {}
    return p



_COMPACT_PROP_KEYS = ("path", "title", "status", "kind", "vault", "language", "extension")
_COMPACT_GLOSS_KEYS = ("one_line_summary", "summary")
_COMPACT_GLOSS_CHARS = 120


def _compact_node(node: dict[str, Any]) -> dict[str, Any]:
    """Project a node to the fields that matter when scanning a list.

    Use ``get_node`` or ``load_source`` for the full record; pass
    ``verbose=True`` to ``list_nodes`` to opt back into whole property blobs."""
    props = _props(node)
    out: dict[str, Any] = {"id": node.get("id"), "type": node.get("type"), "name": node.get("name")}
    for k in _COMPACT_PROP_KEYS:
        if (v := props.get(k)) not in (None, ""):
            out[k] = v
    for k in _COMPACT_GLOSS_KEYS:
        v = props.get(k)
        if isinstance(v, str) and v.strip():
            t = v.strip()
            out["summary"] = t if len(t) <= _COMPACT_GLOSS_CHARS else t[: _COMPACT_GLOSS_CHARS - 1] + "…"
            break
    return out


def _json_list_window(items: list[Any], *, offset: int, more: bool, budget: int = MAX_LIST_RESULT_CHARS) -> str:
    """Serialize a list window as valid JSON, dropping items until it fits.

    ALWAYS returns the same object shape — ``{items, returned, offset,
    hasMore, hint}`` — never a bare list. A shape that varied with whether
    more data existed was a footgun: ``list_nodes(limit=1)`` returned an
    object while ``limit=1000`` returned a list, so any caller writing
    ``result[0]`` broke exactly when the set was bigger than the window
    (it broke 8 tests the moment it shipped).

    ``hasMore`` is the completeness signal: false means this really is the
    whole set, which is what makes an absence claim safe. Items are dropped
    whole to fit the budget — a JSON document is never string-sliced."""
    kept = list(items)
    while True:
        dropped = len(items) - len(kept)
        has_more = more or dropped > 0
        payload = {
            "items": kept,
            "returned": len(kept),
            "offset": offset,
            "hasMore": has_more,
            "hint": (
                f"more available — repeat with offset={offset + len(kept)}"
                + (f" ({dropped} item(s) dropped to fit the response cap)" if dropped else "")
                if has_more
                else "end of set — this is every match"
            ),
        }
        text = json.dumps(payload, default=str)
        if len(text) <= budget:
            return text
        if not kept:
            return json.dumps(
                {
                    "items": [],
                    "returned": 0,
                    "offset": offset,
                    "hasMore": True,
                    "hint": "individual items exceed the response cap; fetch them singly with get_node",
                }
            )
        kept.pop()


def _graph_has_docs(store: GraphStore | None) -> bool:
    """True when this index contains at least one KnowledgeDoc.

    Cheap (LIMIT 1) and evaluated once per server, so the tool surface can
    describe the graph it is actually pointed at."""
    if store is None:
        return False
    try:
        return bool(store.list_nodes(node_type=NODE_TYPE_KNOWLEDGE_DOC_NAME, limit=1))
    except Exception:
        return False


_DOC_TYPES_NOTE = """

    Documentation types (this index HAS them):

    * ``KnowledgeDoc`` — one node per indexed document. Listing these
      enumerates the documentation corpus: each carries ``title``,
      ``one_line_summary``, ``path``, and ``status``. This is the reliable way
      to answer "every document that…" — call it with ``paged=True`` so you get
      the compact projection and the ``hasMore`` completeness signal (a whole
      corpus of documents does not fit in the unpaged full-node shape), then
      read candidates with ``load_source``.
    ``filters`` matches on node properties, so scoping works too — e.g.
    ``type="KnowledgeDoc", filters={"status": "design_history"}`` lists only
    proposals/specs/ADRs, and ``{"status": "authoritative"}`` only current
    documentation."""

_DOC_HITS_NOTE = """

    This index also contains documentation, so a hit may be:

    * ``KnowledgeDoc`` — an indexed document, matched on its title, its
      one-line summary, and its path. The hit itself carries ``title``,
      ``status`` (current documentation vs proposal/spec), ``one_line_summary``
      and ``path`` — triage on those, then read the VERBATIM text with
      ``load_source`` on the ids worth opening. Such a hit may carry
      ``fileTwin``: the id of the ``File`` node for the same document, if you
      want the code-tree view. Each document appears at most ONCE — the doc
      node and its File twin are merged into a single hit.

    A document is the unit of knowledge here — there is no summary or concept
    layer standing in front of it. So a hit is a pointer to text you then
    READ: ``load_source`` for one document, ``grep`` to sweep every
    document's body at once, ``list_nodes`` to enumerate the corpus.

    ``nodeTypes`` accepts these as a comma-separated filter, e.g.
    ``nodeTypes="KnowledgeDoc"`` to search documents only."""

_DOC_EDGES_NOTE = """

    Documentation edges (this index HAS them):

    * ``LINKS_TO`` — between ``KnowledgeDoc`` nodes, a relative link one
      document's AUTHOR wrote to another. The doc-side analogue of imports:
      use it for reading paths, hub documents, and "what references this doc".
    * ``MIRRORS`` — ``KnowledgeDoc`` → the ``File`` twin for the same
      document; the one-hop join between the doc layer and the code tree.

    There is no edge from a document to a topic or concept it discusses.
    "Every doc that discusses X" is a CONTENT question, not a traversal: sweep
    it with ``grep`` in one call."""


def _to_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _dump_body_result(result: dict[str, Any]) -> str:
    """JSON-encode a read result, soft-capping an oversized ``body``.

    Bypasses ``_json_response``'s 4 KB truncation (document bodies run
    larger by design) but still bounds the payload.
    """
    body = result.get("body")
    if isinstance(body, str) and len(body) > MAX_SOURCE_BODY_CHARS:
        # Cut on a line boundary and say how to continue — a bare slice leaves
        # the agent with no way forward, which is how one arm dead-ended
        # re-requesting a 91 KB file.
        head = body[:MAX_SOURCE_BODY_CHARS]
        cut = head.rfind("\n")
        if cut > 0:
            head = head[:cut]
        lines_shown = head.count("\n") + 1
        result = {
            **result,
            "body": head,
            "truncated": True,
            "totalChars": len(body),
            "hint": f'showed the first {lines_shown} lines; pass lineRange="{lines_shown + 1}-" to continue',
        }
    return json.dumps(result, default=str)


def _resolve_repo_file(store: GraphStore, file_path: str):
    """Resolve a (possibly repo-relative) file path to an existing path on disk.

    Mirrors the CLI ``source-read`` resolution: absolute first, then each
    indexed repo's ``repoPath``, then cwd. Returns ``None`` if not found.
    """
    from pathlib import Path

    p = Path(file_path)
    if p.is_absolute() and p.exists():
        return p
    for entry in store.get_metadata():
        repo_path = entry.get("repoPath")
        if repo_path:
            candidate = Path(repo_path) / file_path
            if candidate.exists():
                return candidate
    cwd_candidate = Path.cwd() / file_path
    if cwd_candidate.exists():
        return cwd_candidate
    return None


def _read_file_slice(abs_path, start_line: int | None, end_line: int | None) -> dict[str, Any]:
    """Read a whole file or a 1-based inclusive line slice into a result dict."""
    from pathlib import Path

    path = Path(abs_path)
    if start_line is None:
        return {"path": str(abs_path), "body": path.read_text()}

    start_idx = max(1, start_line)
    selected: list[str] = []
    total = 0
    with path.open() as f:
        for lineno, raw in enumerate(f, start=1):
            total = lineno
            if lineno < start_idx:
                continue
            if end_line is not None and lineno > end_line:
                break
            selected.append(raw.rstrip("\n"))
    resolved_end = end_line if end_line is not None else total
    return {
        "path": str(abs_path),
        "lineRange": f"{start_idx}-{resolved_end}",
        "body": "\n".join(selected),
    }


# Unranged document reads are head-capped to this many chars. The MCP CLIENT
# rejects tool results over its own token cap (~25k tokens) outright, telling
# the agent to read a spill file with tools a restricted session may not have —
# a dead end (observed: an arm stuck re-requesting DOCS.md, 91 KB). A capped
# head + explicit lineRange continuation always fits and always gives the
# agent a way forward. Sized for the worst case: table-heavy markdown
# tokenizes at ~2.5 chars/token (a 64 KB head was still rejected), so 40 KB
# ≈ 16k tokens leaves margin for the JSON envelope.
DOC_BODY_HEAD_CHARS = MAX_SOURCE_BODY_CHARS  # same budget for both paths — see above


def _slice_doc_body(result: dict[str, Any], start_line: int | None, end_line: int | None) -> dict[str, Any]:
    """Apply a 1-based inclusive line slice to a document read result.

    With a range: return exactly those lines plus ``lineRange``/``totalLines``.
    Without one: return the whole body when small, else the head that fits
    ``DOC_BODY_HEAD_CHARS`` with ``truncated`` + a continuation hint. Error
    results (no ``body``) pass through untouched.
    """
    body = result.get("body")
    if not isinstance(body, str):
        return result
    lines = body.split("\n")
    total = len(lines)
    if start_line is not None:
        s = max(1, start_line)
        e = min(end_line, total) if end_line is not None else total
        return {**result, "body": "\n".join(lines[s - 1 : e]), "lineRange": f"{s}-{e}", "totalLines": total}
    if len(body) <= DOC_BODY_HEAD_CHARS:
        return {**result, "totalLines": total}
    used = 0
    cut = 0
    for line in lines:
        used += len(line) + 1
        if used > DOC_BODY_HEAD_CHARS:
            break
        cut += 1
    cut = max(1, cut)
    return {
        **result,
        "body": "\n".join(lines[:cut]),
        "lineRange": f"1-{cut}",
        "totalLines": total,
        "truncated": True,
        "hint": f'body is {total} lines; pass lineRange="{cut + 1}-" (or smaller chunks) to read the rest',
    }


class InvalidLineRange(ValueError):
    """A non-empty lineRange that couldn't be parsed. Callers surface this as
    a loud error — silently falling back to the whole body turns an agent's
    paging attempt into an oversized response the MCP client rejects."""


def _parse_line_range(spec: str) -> tuple[int | None, int | None]:
    """Parse ``"10-25"`` / ``"10-"`` / ``"10"`` into ``(start, end)``.

    Tolerates ``,`` / ``:`` / whitespace as the separator (agents improvise
    formats); raises :class:`InvalidLineRange` on anything unparseable.
    """
    spec = (spec or "").strip()
    if not spec:
        return None, None
    m = re.fullmatch(r"(\d+)\s*(?:[-,:]|\s)\s*(\d+)?", spec) or re.fullmatch(r"(\d+)", spec)
    if not m:
        raise InvalidLineRange(f'invalid lineRange {spec!r} — use "10-25", "10-", or "10"')
    start = int(m.group(1))
    if m.re.groups == 1:
        return start, start
    end = int(m.group(2)) if m.group(2) else None
    return start, end


def _load_code_source(
    store: GraphStore,
    node: dict[str, Any],
    node_id: str,
    start_line: int | None,
    end_line: int | None,
) -> dict[str, Any]:
    """Read source for a code-layer node from the repo checkout on disk."""
    props = _props(node)
    file_path = props.get("path")
    # Fall back to the node's own recorded range when no explicit range given.
    if start_line is None and end_line is None:
        start_line = _to_int(props.get("start_line") or props.get("startLine"))
        end_line = _to_int(props.get("end_line") or props.get("endLine"))

    # A symbol node (Function/Class/...) may carry no path itself; it's
    # DEFINED in a File node that does.
    if not file_path:
        try:
            for nb_node, _nb_rel in store._get_neighbors(node_id, "outgoing"):
                if nb_node.get("type") == "File":
                    fp = _props(nb_node).get("path")
                    if fp:
                        file_path = fp
                        break
        except Exception:
            pass

    # Last resort: the path is encoded in the node id (``repo/path::Symbol``).
    if not file_path and "::" in node_id:
        from opentrace_agent.cli.source_search import strip_repo_prefix

        candidate = node_id.split("::", 1)[0]
        repo_ids = sorted(store.list_repository_ids(), key=len, reverse=True)
        stripped = strip_repo_prefix(candidate, repo_ids)
        if stripped:
            file_path = stripped

    if not file_path:
        return {"error": f"node {node_id} (type={node.get('type')}) has no resolvable file path"}

    abs_path = _resolve_repo_file(store, file_path)
    if abs_path is None:
        return {"error": f"source file not found on disk: {file_path}"}

    result = _read_file_slice(abs_path, start_line, end_line)
    return {"nodeId": node_id, "type": node.get("type"), **result}


# What each epistemic status means for a reader, spelled out at read time so
# the label travels with the document body rather than sitting unseen on a node.
_STATUS_NOTES = {
    "authoritative": (
        "Current documentation. Still a doc, not the code — verify exact behaviour against the implementation."
    ),
    "design_history": (
        "Design proposal / spec / ADR / changelog — describes INTENT and may be "
        "superseded by the implementation. A claim resting only on this is what "
        "was proposed, NOT what ships. Confirm against code or an authoritative "
        "doc before stating it as current behaviour."
    ),
    "design_history_archived": (
        "Archived design proposal / spec — describes intent, likely superseded. "
        "Treat as historical record, not current behaviour."
    ),
}


def _load_corpus_doc(store: GraphStore, node: dict[str, Any], node_id: str) -> dict[str, Any]:
    """Read a ``KnowledgeDoc`` node's body from the content-addressed corpus snapshot.

    The returned payload carries the document's epistemic ``status`` and a
    plain-language ``statusNote`` alongside the body — the label is useless if
    it isn't present at the moment the agent reads the text."""
    from pathlib import Path

    props = _props(node)
    corpus_rel = props.get("corpus_path")
    if not corpus_rel:
        return {"error": f"KnowledgeDoc {node_id} has no corpus_path"}
    # corpus_path is always a repo-relative ``corpus/<sha>.md`` — reject anything
    # that tries to escape the DB directory.
    if ".." in corpus_rel or corpus_rel.startswith("/"):
        return {"error": f"invalid corpus_path: {corpus_rel}"}
    db_path = getattr(store, "db_path", None)
    if not db_path:
        return {"error": "store has no db_path; cannot locate corpus"}
    body_path = Path(str(db_path)).parent / corpus_rel
    if not body_path.exists():
        return {"error": f"corpus file not found: {body_path}"}
    out: dict[str, Any] = {
        "nodeId": node_id,
        "type": "KnowledgeDoc",
        "filename": props.get("filename"),
        "sha256": props.get("sha256"),
        "contentType": props.get("content_type"),
    }
    if title := props.get("title"):
        out["title"] = title
    if path := props.get("path"):
        out["path"] = path
    if summary := props.get("one_line_summary"):
        out["summary"] = summary
    # Epistemic status travels WITH the body: a label the agent can't see at
    # the moment of reading does nothing.
    status = props.get("status") or "authoritative"
    out["status"] = status
    out["statusNote"] = _STATUS_NOTES.get(status, _STATUS_NOTES["authoritative"])
    out["body"] = body_path.read_text(encoding="utf-8")
    return out


def create_mcp_server(store: GraphStore | None) -> FastMCP:
    """Create a FastMCP server with graph query tools backed by *store*.

    When *store* is ``None`` (no database found), every tool returns a
    friendly "no index" response instead of raising an error.
    """
    server = FastMCP("opentrace")

    @server.tool()
    def search_graph(
        query: str,
        limit: int = 25,
        nodeTypes: str = "",
        vaultScope: str = "",
    ) -> str:
        """Ranked FTS search across graph nodes — code AND documentation.

        Returns ``{hits, count, query}`` where each hit is
        ``{id, type, name, snippet, score, vault, recency, confidence}``. The
        ``vault`` / ``recency`` / ``confidence`` fields are populated where
        the underlying property is set on the node; otherwise ``null``.
        Optional ``vaultScope`` restricts hits to a single vault by name.

        (Documentation hit types — including the per-hit triage fields on
        document hits — are appended to this description by
        ``_DOC_HITS_NOTE`` only when the open index contains them.)

        Results are RANKED AND TRUNCATED, so this tool cannot show that
        something is absent, and re-issuing it with reworded queries does not
        fix that — each query is another ranked sample, so a document that
        phrased the idea unexpectedly stays invisible however many times you
        ask. For whole-corpus questions use the exhaustive tool that matches
        what you're enumerating: ``list_nodes`` for NODES ("list every
        document", "which X have no Y"), ``grep`` for CONTENT ("which sites
        face a capacity problem" → sweep ``"constraint|shortage|capacity"``
        once over every body)."""
        if not store:
            logger.info("search_graph called but no index exists")
            return NO_INDEX_MSG
        logger.debug(
            "search_graph(query=%r, limit=%d, nodeTypes=%r, vaultScope=%r)",
            query,
            limit,
            nodeTypes,
            vaultScope,
        )
        try:
            node_types = [t.strip() for t in nodeTypes.split(",") if t.strip()] or None
            limit = min(limit, 200)
            scope = vaultScope.strip() or None
            result = _search(
                store,
                query,
                limit=limit,
                node_types=node_types,
                vault_scope=scope,
            )
            return _json_response(result)
        except Exception as e:
            return _error_response("search_graph", e)

    @server.tool()
    def list_nodes(
        type: str,
        limit: int = 50,
        filters: dict[str, Any] | None = None,
        paged: bool = False,
        offset: int = 0,
        verbose: bool = False,
    ) -> str:
        """List every node of a type — the exhaustive counterpart to ``search_graph``.

        Use this whenever a question asks for completeness ("list every…",
        "which X have no Y…", "across the whole repository…"). ``search_graph``
        is ranked and truncated, so it CANNOT establish that something is
        absent; this can.

        Code types: Repository, Class, Function, File, Directory, Package,
        Module, Service, Endpoint, Database. ``filters`` is an EXACT match on a
        node property — not a prefix or glob, so ``{"path": "cmd/engram"}``
        matches nothing; to scope by a path fragment use ``grep`` or
        ``search_graph``. (Documentation node types are appended to this
        description by ``_DOC_TYPES_NOTE`` only when the open index contains
        them.)

        **For completeness questions pass ``paged=True``.** That returns
        ``{items, returned, offset, hasMore, hint}``, where **``hasMore:
        false`` is the completeness signal** — it means these really are all
        the matches, which is what makes "there is no X" safe to assert. When
        it's true, page on with ``offset`` (the ``hint`` gives the next value)
        or narrow with ``filters``; never conclude absence from a partial page.
        Paged items are a compact projection — ``id``, ``type``, ``name`` plus
        triage fields (``path``, ``title``, ``status``, ``summary``, …) — so a
        whole corpus fits in one response; add ``verbose=True`` for full
        property blobs, or use ``get_node`` / ``load_source`` on one id.

        Without ``paged`` this returns a plain JSON array of full nodes (the
        long-standing shape). That array carries no completeness signal, so
        prefer ``paged=True`` whenever absence matters."""
        if not store:
            logger.info("list_nodes called but no index exists")
            return NO_INDEX_MSG
        logger.debug("list_nodes(type=%r, limit=%d, filters=%r, paged=%r)", type, limit, filters, paged)
        try:
            limit = min(limit, 1000)
            offset = max(0, offset)
            # Default stays the PRE-EXISTING contract: a plain array of full
            # nodes. The compact paged window is an ADDITION, opt-in via
            # `paged` (or implied by a non-zero `offset`, which is meaningless
            # without it). `list_nodes` predates the vault work, so silently
            # changing its response shape would break consumers that were here
            # first — flipping the default is a deliberate change to make on
            # its own, not a side effect of adding docs retrieval.
            if not paged and offset == 0:
                nodes = store.list_nodes(node_type=type, filters=filters, limit=limit)
                logger.debug("list_nodes → %d results (unpaged, legacy shape)", len(nodes))
                return _json_response(nodes)
            nodes = store.list_nodes(node_type=type, filters=filters, limit=offset + limit + 1)
            total_seen = len(nodes)
            window = nodes[offset : offset + limit]
            logger.debug("list_nodes → %d results (offset=%d)", len(window), offset)
            items = window if verbose else [_compact_node(n) for n in window]
            return _json_list_window(items, offset=offset, more=total_seen > offset + len(window))
        except Exception as e:
            return _error_response("list_nodes", e)

    @server.tool()
    def get_node(nodeId: str) -> str:
        """Get full details of a single node plus its immediate neighbours.

        Each neighbour entry includes a pre-summarised ``target_summary`` so
        the agent can decide whether to recurse without a follow-up fetch:
        ``one_line_summary`` for indexed documents, truncated
        ``summary``/``name`` for code nodes.
        """
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
                "neighbors": [
                    {
                        "node": n["node"],
                        "relationship": n["relationship"],
                        "target_summary": _neighbour_summary(n["node"]),
                    }
                    for n in neighbors
                ],
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
        edgeTypes: str = "",
        vaultScope: str = "",
        confidenceThreshold: float = 0.0,
    ) -> str:
        """Walk relationships from a starting node.

        Direction can be 'outgoing', 'incoming', or 'both'.

        Filter the walk by relationship type via either ``relationship`` (a
        single type, e.g. 'CALLS') or ``edgeTypes`` (a comma-separated set,
        e.g. 'CALLS,IMPORTS'). When both are given, ``edgeTypes`` wins.

        Code edges: ``CALLS``, ``IMPORTS``, ``DEFINES``, ``CONTAINS``,
        ``INHERITS_FROM``. (Documentation edge types are appended to this
        description by ``_DOC_EDGES_NOTE`` only when the index contains them.)

        Optional ``vaultScope`` restricts traversal to nodes whose ``vault``
        property matches the given vault name. ``confidenceThreshold`` (0.0-1.0)
        skips relationships whose ``properties.confidence`` falls below the
        threshold; values <= 0 disable the filter."""
        if not store:
            logger.info("traverse_graph called but no index exists")
            return NO_INDEX_MSG
        logger.debug(
            "traverse_graph(nodeId=%r, depth=%d, direction=%r, relationship=%r, edgeTypes=%r)",
            nodeId,
            depth,
            direction,
            relationship,
            edgeTypes,
        )
        try:
            if direction not in ("outgoing", "incoming", "both"):
                return json.dumps(
                    {"error": f"Invalid direction: {direction}. Must be 'outgoing', 'incoming', or 'both'."}
                )
            depth = min(depth, 10)
            rel_types = [t.strip() for t in edgeTypes.split(",") if t.strip()] or None
            rel_type = relationship if (relationship and not rel_types) else None
            vault = vaultScope.strip() or None
            conf = confidenceThreshold if confidenceThreshold > 0 else None
            results = store.traverse(
                nodeId,
                direction=direction,
                max_depth=depth,
                relationship_type=rel_type,
                relationship_types=rel_types,
                vault_scope=vault,
                confidence_threshold=conf,
            )
            return _json_response(results)
        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            return _error_response("traverse_graph", e)

    @server.tool(name="find_path")
    def find_path(
        startId: str,
        endId: str,
        maxHops: int = 5,
        edgeTypes: str = "",
    ) -> str:
        """Find the shortest path between two nodes via outgoing edges.

        Returns a list of {node, relationship, depth} steps from start to end,
        or {path: null} if no path exists within maxHops. Optionally filter
        the walk to specific edge types via a comma-separated edgeTypes list
        (e.g. "CALLS,IMPORTS").
        """
        if not store:
            logger.info("find_path called but no index exists")
            return NO_INDEX_MSG
        try:
            edge_list = [t.strip() for t in edgeTypes.split(",") if t.strip()] or None
            return _json_response(_find_path(store, startId, endId, max_hops=maxHops, edge_types=edge_list))
        except Exception as e:
            return _error_response("find_path", e)

    @server.tool(name="find_orphans")
    def find_orphans(
        nodeType: str,
        edgeType: str,
        direction: str = "incoming",
        limit: int = 1000,
    ) -> str:
        """Find nodes of a given type that have no edges of edgeType in the
        given direction. direction is 'incoming', 'outgoing', or 'both'.

        Use this to find unused functions ('Function', 'CALLS', 'incoming'),
        unreferenced documents ('KnowledgeDoc', 'LINKS_TO', 'incoming'), etc.
        """
        if not store:
            logger.info("find_orphans called but no index exists")
            return NO_INDEX_MSG
        try:
            result = _find_orphans(store, nodeType, edgeType, direction=direction, limit=limit)
            # An orphan set is only meaningful against the population it was
            # computed over, and for documents that population is NOT the repo:
            # only files the doc pass ingested become KnowledgeDocs (extension
            # filter + content gate), and byte-identical files collapse to one
            # node. Measured on one repo: 189 KnowledgeDocs for 401 .md files.
            # Without this the caller reads subset-truth as whole-truth — which
            # is exactly how an agent reported documents as unlinked when the
            # linking document simply wasn't in the graph.
            if isinstance(result, dict):
                result["scope"] = _population_note(store, nodeType, edgeType)
            return _json_response(result)
        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            return _error_response("find_orphans", e)

    @server.tool(name="find_via_relationship_to_type")
    def find_via_relationship_to_type(
        startType: str,
        edgeType: str,
        targetType: str,
        limit: int = 100,
    ) -> str:
        """Find all (A, B) pairs where A is startType, B is targetType, and a
        relationship of edgeType points from A to B.

        Examples: Functions that CALL Endpoints, KnowledgeDocs that LINKS_TO KnowledgeDocs.
        """
        if not store:
            logger.info("find_via_relationship_to_type called but no index exists")
            return NO_INDEX_MSG
        try:
            return _json_response(_find_via_relationship_to_type(store, startType, edgeType, targetType, limit=limit))
        except Exception as e:
            return _error_response("find_via_relationship_to_type", e)

    @server.tool(name="count_by")
    def count_by(
        nodeType: str,
        parentId: str = "",
        parentEdge: str = "CONTAINS",
        maxHops: int = 3,
    ) -> str:
        """Count nodes of nodeType, optionally scoped to descendants of parentId
        reachable via parentEdge (e.g. CONTAINS) within maxHops.

        Without parentId: total count across the graph.
        With parentId: count of matching descendants under that parent.
        """
        if not store:
            logger.info("count_by called but no index exists")
            return NO_INDEX_MSG
        try:
            parent = parentId.strip() or None
            return _json_response(
                _count_by(
                    store,
                    nodeType,
                    parent_id=parent,
                    parent_edge=parentEdge,
                    max_hops=maxHops,
                )
            )
        except Exception as e:
            return _error_response("count_by", e)

    @server.tool(name="grep")
    def grep(
        pattern: str,
        scopeId: str,
        fileFilter: str = "",
        caseSensitive: bool = False,
        maxResults: int = 200,
    ) -> str:
        """Regex grep over the on-disk content reachable from a scope node.

        ``scopeId`` accepts a Repository or KnowledgeVault **id or plain
        name** — `"my-docs"`, `"vault::my-docs"`, and a repo's name all
        resolve, so a name from `list_vaults` / `get_stats` can be passed
        straight through. An unresolvable scope lists the valid ones.
        A vault grep sweeps EVERY member document's full normalized body —
        use it to establish exhaustive claims
        about CONTENT, the way ``list_nodes`` establishes existence of nodes;
        ranked ``search_graph`` can do neither.

        This covers concept-shaped sweeps, not just exact strings. When the
        answer is spread over documents that each word it differently, pass an
        alternation of the vocabulary they might use rather than issuing
        repeated ``search_graph`` queries and hoping one surfaces the right
        document — e.g. ``"constraint|shortage|capacity"`` for "which sites
        face a capacity problem", or ``"supersede[sd]?|replaces|deprecated"``
        for "what has been replaced". One sweep over 48 documents is cheaper
        than six ranked searches and, unlike them, it cannot silently miss a
        document that used an unexpected synonym.

        Vault matches come back joined to their document:
        ``node_id`` (pass to ``load_source``), display ``file_path``,
        ``title``, ``status``, with line numbers referring to the normalized
        body ``load_source`` returns.

        Returns matches with file_path, line_number, line_text, and
        structural_context. Falls back to a structured error when the scope
        has no on-disk content available; agent should then fall back to
        ``search_graph`` for FTS over indexed metadata.
        """
        if not store:
            logger.info("grep called but no index exists")
            return NO_INDEX_MSG
        try:
            return _fit_grep_response(
                _grep(
                    store,
                    pattern,
                    scope_id=scopeId,
                    file_filter=fileFilter or None,
                    case_sensitive=caseSensitive,
                    max_results=maxResults,
                )
            )
        except Exception as e:
            return _error_response("grep", e)

    @server.tool(name="provenance")
    def provenance(nodeId: str) -> str:
        """Return the trust chain for a node.

        For an indexed document: its own identity — sha256, filename,
        root-relative path, ingest time, and the ``MIRRORS`` File twin when it
        came from a repo walk (read the bytes via ``load_source``).

        For code nodes: commit_sha + indexer_version from the per-repo
        IndexMetadata, plus file_path and line_range from the node itself.
        """
        if not store:
            logger.info("provenance called but no index exists")
            return NO_INDEX_MSG
        try:
            return _json_response(_provenance(store, nodeId))
        except Exception as e:
            return _error_response("provenance", e)

    @server.tool(name="overview")
    def overview(topN: int = 5, vaultScope: str = "") -> str:
        """Compact orientation of the indexed graph for agent session start.

        Returns counts by node type, the most-connected concepts, and the
        most recently updated nodes. Targets <500 tokens. Optional
        ``vaultScope`` is reserved for the vault-graph rollout — currently
        no-op.
        """
        if not store:
            logger.info("overview called but no index exists")
            return NO_INDEX_MSG
        try:
            scope = vaultScope.strip() or None
            return _json_response(_overview(store, top_n=topN, vault_scope=scope))
        except Exception as e:
            return _error_response("overview", e)

    @server.tool()
    def get_communities(limit: int = 100) -> str:
        """List detected communities (Leiden/Louvain clusters) with cohesion and member counts.

        Run ``opentraceai cluster`` first to populate community membership.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            rows = _list_communities(store)[: min(limit, 1000)]
            return _json_response(rows)
        except Exception as e:
            return _error_response("get_communities", e)

    @server.tool()
    def get_god_nodes(limit: int = 20) -> str:
        """List top-degree non-internal nodes — the centrality hubs of the graph.

        Useful as the first thing to check when exploring an unfamiliar codebase.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            return _json_response(_god_nodes(store, limit=min(limit, 200)))
        except Exception as e:
            return _error_response("get_god_nodes", e)

    @server.tool()
    def get_bridges(limit: int = 50) -> str:
        """List edges whose endpoints belong to different communities.

        Cross-community edges are the bridges that hold otherwise distinct
        regions of the graph together — useful for orienting on which
        components are coupling concerns that look unrelated by name.
        Run ``opentraceai cluster`` first; empty until communities exist.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            return _json_response(_cross_community_bridges(store, limit=min(limit, 500)))
        except Exception as e:
            return _error_response("get_bridges", e)

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

    @server.tool()
    def list_vaults() -> str:
        """List KnowledgeVault nodes present in the current graph.

        Returns ``{vaults: [{name, scope, last_compiled_at, summary}]}``.
        Empty unless a vault has been compiled via ``opentraceai index
        --wiki`` or attached via ``opentraceai vault attach``.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            nodes = store.list_nodes(node_type="KnowledgeVault", limit=1000)
            vaults = []
            for n in nodes:
                props = n.get("properties") or {}
                vaults.append(
                    {
                        "name": props.get("vault") or n.get("name"),
                        "scope": props.get("scope"),
                        "last_compiled_at": props.get("last_compiled_at"),
                        "summary": props.get("summary"),
                    }
                )
            return _json_response({"vaults": vaults})
        except Exception as e:
            return _error_response("list_vaults", e)

    @server.tool()
    def load_source(nodeId: str, lineRange: str = "") -> str:
        """Read the underlying content for a graph node, dispatching by type.

        One read primitive across every content layer — the node is the
        pointer, this tool returns the bytes:

        - **Code** nodes (``Function`` / ``Class`` / ``File`` / ``Variable`` /
          …) → source read from the indexed repo checkout. Defaults to the
          node's own recorded line range.
        - **KnowledgeDoc** nodes (ingested docs) → the document body VERBATIM
          from the content-addressed corpus snapshot (``corpus/<sha>.md``),
          independent of the working tree, alongside its ``status`` +
          ``statusNote``. Nothing paraphrases a document: what you get is what
          its author wrote. The body is authoritative for what the docs
          say/design/intend, but any code-behavior claim must be confirmed
          against the code before you assert it.

        ``lineRange`` (``"10-25"``, ``"10-"``, or ``"10"``) works on EVERY
        node type — use it to page through large documents. An
        unranged read of a large doc returns the head plus ``truncated``,
        ``totalLines``, and a ``hint`` with the lineRange to continue from —
        follow it rather than re-requesting the whole body.

        Returns ``{nodeId, type, body, …}``.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            node = store.get_node(nodeId)
            if not node:
                return json.dumps({"error": f"node not found: {nodeId}"})
            node_type = node.get("type")
            try:
                start_line, end_line = _parse_line_range(lineRange)
            except InvalidLineRange as e:
                return json.dumps({"error": str(e)})
            if node_type == "KnowledgeDoc":
                return _dump_body_result(_slice_doc_body(_load_corpus_doc(store, node, nodeId), start_line, end_line))
            return _dump_body_result(_load_code_source(store, node, nodeId, start_line, end_line))
        except Exception as e:
            return _error_response("load_source", e)

    @server.tool()
    def find_cross_cutting_communities(min_domains: int = 2, limit: int = 50) -> str:
        """List Communities whose members span ≥``min_domains`` domains
        (code / doc — the legacy runtime-node domain is only populated on
        graphs built by other producers).

        Requires ``opentraceai cluster`` to have been run first; returns an
        empty list when no Community nodes exist.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            cap = min(limit, 500)
            result = _find_communities_spanning_domains(store, min_domains=min_domains, limit=cap)
            return _json_response(result)
        except Exception as e:
            return _error_response("find_cross_cutting_communities", e)

    # Only advertise the documentation types when this index has them: on a
    # code-only graph the doc copy makes an agent chase a layer that isn't there.
    if _graph_has_docs(store):
        for tool_name, note in (
            ("list_nodes", _DOC_TYPES_NOTE),
            ("search_graph", _DOC_HITS_NOTE),
            ("traverse_graph", _DOC_EDGES_NOTE),
        ):
            tool = server._tool_manager._tools.get(tool_name)
            if tool is not None and getattr(tool, "description", None):
                tool.description = tool.description.rstrip() + note

    return server
