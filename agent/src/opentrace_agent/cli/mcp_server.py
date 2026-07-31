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
    find_entities_mentioned_by as _find_entities_mentioned_by,
)
from opentrace_agent.retrieval import (
    find_orphans as _find_orphans,
)
from opentrace_agent.retrieval import (
    find_pages_mentioning as _find_pages_mentioning,
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

    Prefer ``one_line_summary`` (set on KnowledgeConcept by the wiki compile pipeline);
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

# Source/page bodies legitimately exceed the 4 KB tool-response cap that
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


MAX_LIST_RESULT_CHARS = 20000

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
      to answer "every document that…" — read candidates with ``load_source``.
    * ``KnowledgeConcept`` — compiled concept pages; often none (they are
      opt-in). An empty list is normal.
    * ``Idea`` / ``Service`` / ``Module`` / ``Paper`` / ``Person`` / ``Event``
      — entities extracted from the docs.

    ``filters`` matches on node properties, so scoping works too — e.g.
    ``type="KnowledgeDoc", filters={"status": "design_history"}`` lists only
    proposals/specs/ADRs, and ``{"status": "authoritative"}`` only current
    documentation."""

_DOC_HITS_NOTE = """

    This index also contains documentation, so a hit may be:

    * ``KnowledgeDoc`` — an indexed document, matched on its title, its
      one-line summary, and its path. Read the VERBATIM text with
      ``load_source`` on the hit's id; that response also carries the
      document's epistemic ``status`` (current documentation vs
      proposal/spec). Such a hit may carry ``fileTwin``: the id of the ``File``
      node for the same document, if you want the code-tree view. Each
      document appears at most ONCE — the doc node and its File twin are
      merged into a single hit.
    * ``Idea`` / ``Service`` / ``Module`` / ``Paper`` / ``Person`` / ``Event``
      — an entity extracted from the docs. These often rank highly because
      their names are short; an entity is a signpost, not an answer. Follow it
      to the documents with ``find_pages_mentioning`` (or ``traverse_graph``
      over ``MENTIONS`` / ``DERIVED_FROM``).
    * ``KnowledgeConcept`` — a compiled concept page, when the vault has any.

    ``nodeTypes`` accepts these as a comma-separated filter, e.g.
    ``nodeTypes="KnowledgeDoc"`` to search documents only."""

_DOC_EDGES_NOTE = """

    Documentation edges (this index HAS them):

    * ``LINKS_TO`` — between ``KnowledgeDoc`` nodes, a relative link one
      document's AUTHOR wrote to another. The doc-side analogue of imports:
      use it for reading paths, hub documents, and "what references this doc".
      (Also connects concept pages to each other, when pages exist.)
    * ``MIRRORS`` — ``KnowledgeDoc`` → the ``File`` twin for the same
      document; the one-hop join between the doc layer and the code tree.
    * ``MENTIONS`` — a document or page → an entity it references.
    * ``DERIVED_FROM`` — an entity → the document it was extracted from.
      "Every doc referencing X" = incoming ``MENTIONS`` ∪ outgoing
      ``DERIVED_FROM`` on X.
    * ``CITES`` — a concept page → its source documents (pages only)."""


def _to_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _dump_body_result(result: dict[str, Any]) -> str:
    """JSON-encode a read result, soft-capping an oversized ``body``.

    Bypasses ``_json_response``'s 4 KB truncation (page/source bodies run
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


# Unranged doc/page reads are head-capped to this many chars. The MCP CLIENT
# rejects tool results over its own token cap (~25k tokens) outright, telling
# the agent to read a spill file with tools a restricted session may not have —
# a dead end (observed: an arm stuck re-requesting DOCS.md, 91 KB). A capped
# head + explicit lineRange continuation always fits and always gives the
# agent a way forward. Sized for the worst case: table-heavy markdown
# tokenizes at ~2.5 chars/token (a 64 KB head was still rejected), so 40 KB
# ≈ 16k tokens leaves margin for the JSON envelope.
DOC_BODY_HEAD_CHARS = MAX_SOURCE_BODY_CHARS  # same budget for both paths — see above


def _slice_doc_body(result: dict[str, Any], start_line: int | None, end_line: int | None) -> dict[str, Any]:
    """Apply a 1-based inclusive line slice to a doc/page read result.

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


def _cited_sources(store: GraphStore, node_id: str) -> list[dict[str, Any]]:
    """The KnowledgeDocs a concept page CITES — its primary sources.

    Surfaced on every page read so agents can cite the primary document
    alongside the page instead of the page alone (a page is a compiled
    synthesis, not a repo document). Reuses the provenance chain-entry
    builder so the MIRRORS File twin comes along; adds the doc's epistemic
    ``status`` so agents can prefer authoritative docs over design history.
    Failures degrade to an empty list — citation hints must never break a
    page read.
    """
    from opentrace_agent.retrieval.provenance import _source_link

    try:
        traversal = store.traverse(node_id, direction="outgoing", max_depth=1, relationship_type="CITES")
    except Exception:
        return []
    cited = []
    for r in traversal:
        n = r.get("node") or {}
        if n.get("type") != "KnowledgeDoc":
            continue
        props = _props(n)
        link = _source_link(n.get("id"), props, store)
        link["status"] = props.get("status") or "authoritative"
        cited.append(link)
    return cited


def _read_concept_body(store: GraphStore, node: dict[str, Any], node_id: str) -> dict[str, Any]:
    """Resolve and read a ``KnowledgeConcept`` node's markdown body from disk."""
    from pathlib import Path

    from opentrace_agent.wiki.paths import resolve_vault_scope

    props = _props(node)
    vault = props.get("vault")
    slug = props.get("slug")
    if not vault or not slug:
        return {"error": f"KnowledgeConcept {node_id} missing vault/slug properties"}
    # Slug is "<kind_dir>/<base>"; reject any traversal nonsense.
    if ".." in slug or slug.startswith(".") or slug.startswith("/") or slug.endswith("/") or slug.count("/") > 1:
        return {"error": f"invalid slug: {slug}"}

    db_path = Path(str(getattr(store, "db_path", "")))
    project_root = db_path.parent.parent if db_path.parent.name == ".opentrace" else None
    resolved = resolve_vault_scope(vault, project_root=project_root)
    if resolved is None:
        return {"error": f"vault '{vault}' not found on disk (local or global)"}
    scope, vault_dir_path = resolved
    page_path = vault_dir_path / "pages" / f"{slug}.md"
    if not page_path.exists():
        return {"error": f"page file not found: {page_path}"}
    return {
        "nodeId": node_id,
        "type": "KnowledgeConcept",
        "vault": vault,
        "slug": slug,
        "scope": scope,
        "body": page_path.read_text(),
        "cited_sources": _cited_sources(store, node_id),
        # Epistemic framing travels with the content so an agent that skims
        # the tool docstring still learns this is documentation knowledge, not
        # a code oracle. See the "Epistemic contract" in read_vault_page.
        "nature": "documentation-synthesis",
        "provenance_note": (
            "Reflects the repository's documentation, not its code. "
            "Authoritative for what the docs say/design/intend; for any "
            "code-behavior claim (wiring, exact values, provenance, "
            "prod-vs-test), confirm against the code before asserting it."
        ),
    }


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

        (Documentation hit types are appended to this description by
        ``_DOC_HITS_NOTE`` only when the open index contains them.)

        Results are RANKED AND TRUNCATED, so this tool cannot show that
        something is absent. For "list every…" / "which X have no Y" /
        whole-corpus questions, use ``list_nodes`` instead."""
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
        type: str, limit: int = 50, filters: dict[str, Any] | None = None, offset: int = 0, verbose: bool = False
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

        Returns ``{items, returned, offset, hasMore, hint}``. **``hasMore:
        false`` is the completeness signal** — it means these really are all
        the matches, which is what makes "there is no X" safe to assert. When
        it's true, page on with ``offset`` (the ``hint`` gives the next value)
        or narrow with ``filters``; never conclude absence from a partial page.

        Each item is a compact projection — ``id``, ``type``, ``name`` plus
        triage fields (``path``, ``title``, ``status``, ``summary``, …) — so a
        whole corpus fits in one response. Pass ``verbose=True`` for full
        property blobs, or use ``get_node`` / ``load_source`` on one id."""
        if not store:
            logger.info("list_nodes called but no index exists")
            return NO_INDEX_MSG
        logger.debug("list_nodes(type=%r, limit=%d, filters=%r)", type, limit, filters)
        try:
            limit = min(limit, 1000)
            offset = max(0, offset)
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
        ``one_line_summary`` for vault pages, truncated ``summary``/``name``
        for code nodes.
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
        dangling wiki pages ('KnowledgeConcept', 'LINKS_TO', 'incoming'), etc.
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

        Examples: Functions that CALL Endpoints, KnowledgeConcepts that CITE KnowledgeDocs.
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

        ``scopeId`` is a Repository (with local_path set) or KnowledgeVault id.
        Returns matches with file_path, line_number, line_text, and
        structural_context. Falls back to a structured error when the scope
        has no on-disk content available; agent should then fall back to
        ``search_graph`` for FTS over indexed metadata.
        """
        if not store:
            logger.info("grep called but no index exists")
            return NO_INDEX_MSG
        try:
            return _json_response(
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

        For wiki pages: agent / model / session / confidence stamped at
        compile time, plus the CITES chain to the original KnowledgeDoc
        artefacts (sha256 + filename; read the bytes via ``load_source``).

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
        most recently updated entities. Targets <500 tokens. Optional
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
    def list_vault_pages(vault: str, kind: str = "", limit: int = 200) -> str:
        """List KnowledgeConcept nodes in a vault (concept pages — the only kind).

        Returns ``{vault, count, pages}`` where each page carries
        ``{id, slug, title, kind, one_line_summary, revision,
        last_updated}``. Use ``read_vault_page`` (or ``load_source``) with
        the returned ``id`` to fetch the page body. KnowledgeDoc documents are
        not pages — find them via ``search_graph`` / ``find_pages_mentioning``
        and read them with ``load_source``.

        **An empty list is normal, not an error.** Concept pages are opt-in
        (``index --wiki --wiki-concept-pages``); a default doc ingestion
        indexes the documents themselves without synthesizing pages. The
        vault's knowledge is then in its KnowledgeDoc nodes and entities —
        reach it via ``search_graph`` (titles, one-line summaries, entity
        descriptions) and ``load_source``, and follow ``LINKS_TO`` between
        KnowledgeDocs for the authors' own cross-references."""
        if not store:
            return NO_INDEX_MSG
        try:
            filters: dict[str, Any] = {"vault": vault}
            if kind.strip():
                filters["kind"] = kind.strip()
            cap = min(limit, 1000)
            nodes = store.list_nodes(node_type="KnowledgeConcept", filters=filters, limit=cap)
            pages = []
            for n in nodes:
                props = n.get("properties") or {}
                pages.append(
                    {
                        "id": n.get("id"),
                        "slug": props.get("slug"),
                        "title": n.get("name"),
                        "kind": props.get("kind"),
                        "one_line_summary": props.get("one_line_summary"),
                        "revision": props.get("revision"),
                        "last_updated": props.get("last_updated"),
                    }
                )
            return _json_response({"vault": vault, "count": len(pages), "pages": pages})
        except Exception as e:
            return _error_response("list_vault_pages", e)

    @server.tool()
    def read_vault_page(nodeId: str) -> str:
        """Return the full markdown body of a KnowledgeConcept from disk.

        KnowledgeConcept bodies live at ``<vault_dir>/pages/<slug>.md`` (the graph
        node carries metadata only — LadybugDB caps STRING properties at
        ~4 KB, wiki pages run 5–20 KB). Resolves the vault's on-disk
        location via local-then-global scope lookup, rooted at the graph's
        project directory (the parent of ``.opentrace/``).

        Returns ``{nodeId, vault, slug, scope, body, cited_sources,
        nature, provenance_note}``. ``cited_sources`` lists the primary
        documents this page was compiled from (``{id, filename, path, status,
        file}``; read them with ``load_source``).

        **Epistemic contract — what this is:** a synthesis of what this repo's
        *documentation* says about a concept. It is faithful to the docs, NOT
        a statement about the code. Documentation can lag, simplify, or
        diverge from the implementation.

        **How to use it:**

        - For questions about what the project *documents, designs, decides,
          or intends* — this page and its ``cited_sources`` are the authority.
          Answer from them and cite them.
        - For questions about what the *code actually does* (behavior, wiring,
          exact values, provenance, prod-vs-test) — a page statement is
          evidence of what's *documented*, not proof of current behavior.
          Confirm the specific against the code (``search_graph`` /
          ``load_source`` on the code node) before asserting it. Do NOT equate
          "the docs say X" with "the code does X".
        - Verifying against this page's own ``cited_sources`` proves nothing
          about the code — the page already reflects them faithfully. Only the
          code settles code behavior.
        - ``cited_sources`` carries each source's ``status``; a claim resting
          only on ``design_history`` is *intent*, not shipped behavior. Prefer
          ``status: authoritative`` sources.
        - Don't count vault pages as repo documents when a question asks about
          the repo's own files.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            node = store.get_node(nodeId)
            if not node:
                return json.dumps({"error": f"node not found: {nodeId}"})
            if node.get("type") != "KnowledgeConcept":
                return json.dumps({"error": f"node {nodeId} is not a KnowledgeConcept (type={node.get('type')})"})
            # Wiki page bodies are 5–20 KB by design; bypass the 4 KB
            # truncation in ``_json_response`` that would chop a page body.
            return _dump_body_result(_read_concept_body(store, node, nodeId))
        except Exception as e:
            return _error_response("read_vault_page", e)

    @server.tool()
    def load_source(nodeId: str, lineRange: str = "") -> str:
        """Read the underlying content for a graph node, dispatching by type.

        One read primitive across every content layer — the node is the
        pointer, this tool returns the bytes:

        - **Code** nodes (``Function`` / ``Class`` / ``File`` / ``Variable`` /
          …) → source read from the indexed repo checkout. Defaults to the
          node's own recorded line range.
        - **KnowledgeDoc** nodes (ingested docs) → the document body from the
          content-addressed corpus snapshot (``corpus/<sha>.md``), independent
          of the working tree.
        - **KnowledgeConcept** nodes → the compiled markdown page body (same as
          ``read_vault_page``, including ``cited_sources`` and its epistemic
          contract: the page reflects the *documentation*, not the code; it is
          authoritative for what the docs say/design/intend, but any
          code-behavior claim must be confirmed against the code — not against
          the page's own cited docs — before you assert it).

        ``lineRange`` (``"10-25"``, ``"10-"``, or ``"10"``) works on EVERY
        node type — use it to page through large documents and pages. An
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
            if node_type == "KnowledgeConcept":
                return _dump_body_result(_slice_doc_body(_read_concept_body(store, node, nodeId), start_line, end_line))
            return _dump_body_result(_load_code_source(store, node, nodeId, start_line, end_line))
        except Exception as e:
            return _error_response("load_source", e)

    @server.tool()
    def find_pages_mentioning(entityId: str) -> str:
        """Find KnowledgeConcepts and KnowledgeDocs whose body mentions a given
        entity, OR that discuss a given code symbol.

        MENTIONS edges only target the entity layer (``Idea`` / ``Service``
        / ``Module`` / ``Paper`` / ``Person`` / ``Event``). If you pass a
        code-layer node id (``Function`` / ``Class`` / ``Variable`` /
        ``File`` / …) directly and the literal traversal returns nothing,
        this tool falls back to a fuzzy entity lookup: it strips any
        trailing Python signature from the symbol name (so
        ``field_validator(str, …)`` becomes ``field_validator``) and then
        finds entities whose name *contains* the bare symbol name (e.g.
        ``"field_validator decorator"`` or ``"@field_validator"``). The
        MENTIONS hits from every match are unioned and returned — so
        "find pages about this function" works without manually chaining
        an entity lookup first.

        Returns ``{entityId, count, pages}``; each hit carries ``type``
        (``KnowledgeConcept`` → read with ``read_vault_page``; ``KnowledgeDoc`` → read
        with ``load_source``).
        """
        if not store:
            return NO_INDEX_MSG
        try:
            pages = _find_pages_mentioning(store, entityId)
            # Trim each hit to the agent-essential fields and bypass the
            # 4 KB truncation cap — find_pages_mentioning can legitimately
            # return 30+ hits whose unabbreviated property dicts overflow
            # the response budget and chop the JSON mid-string.
            trimmed = [
                {
                    "id": p.get("id"),
                    "type": p.get("type"),
                    "name": p.get("name"),
                    "slug": (p.get("properties") or {}).get("slug"),
                    "kind": (p.get("properties") or {}).get("kind"),
                    "one_line_summary": (p.get("properties") or {}).get("one_line_summary"),
                }
                for p in pages
            ]
            return json.dumps(
                {"entityId": entityId, "count": len(trimmed), "pages": trimmed},
                default=str,
            )
        except Exception as e:
            return _error_response("find_pages_mentioning", e)

    @server.tool()
    def find_entities_mentioned_by(pageId: str) -> str:
        """Find entities mentioned by a given KnowledgeConcept.

        Forward-traverses MENTIONS edges. Returns
        ``{pageId, count, entities}``.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            entities = _find_entities_mentioned_by(store, pageId)
            return _json_response({"pageId": pageId, "count": len(entities), "entities": entities})
        except Exception as e:
            return _error_response("find_entities_mentioned_by", e)

    @server.tool()
    def find_cross_cutting_communities(min_domains: int = 2, limit: int = 50) -> str:
        """List Communities whose members span ≥``min_domains`` of the three
        domains (code / entity / page).

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
