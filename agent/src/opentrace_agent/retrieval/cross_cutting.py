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

"""Retrieval helpers that traverse MENTIONS edges between WikiPages and
flat entity nodes (Idea / Service / Module / Paper / Person / Event).

The wiki ingest graph_writer writes MENTIONS edges whenever an entity's
name appears as a whole word in a WikiPage body. These helpers walk in
both directions:

* ``find_pages_mentioning(entity_id)`` — reverse MENTIONS traversal,
  returns the WikiPages that discuss a given entity. Includes a fallback
  for code-symbol queries: if the supplied id points at a code-layer
  node (Function, Class, Variable, File, …) and has no direct MENTIONS
  edges, this function looks up entity-layer nodes whose ``name``
  matches the code symbol's ``name`` and unions the MENTIONS pages
  from those.
* ``find_entities_mentioned_by(page_id)`` — forward MENTIONS, returns
  the entities a page references.

Built thin on top of ``GraphStore.traverse``. Read-only by construction.
"""

from __future__ import annotations

import re
from typing import Any

from opentrace_agent.retrieval.cross_domain import DOMAINS
from opentrace_agent.store import GraphStore

# Strip a trailing Python signature from an extracted symbol name so a
# Function stored as ``field_validator(str, str, ...)`` matches against
# an entity whose name is ``@field_validator`` or ``field_validator
# decorator``. Only trailing parens are stripped; nested parens earlier
# in the name are preserved.
_SIGNATURE_TAIL_RE = re.compile(r"\(.*\)\s*$")


def _strip_signature(name: str) -> str:
    return _SIGNATURE_TAIL_RE.sub("", name).strip()


def find_pages_mentioning(store: GraphStore, entity_id: str) -> list[dict[str, Any]]:
    """Return WikiPages that have a MENTIONS edge to *entity_id*.

    Useful for "which pages discuss this concept?" queries. By design,
    MENTIONS edges in this graph only target the entity layer (Idea,
    Service, Module, Paper, Person, Event) — they're emitted when an
    entity's *name* appears in a page body during wiki compilation. So
    the literal traversal returns zero when *entity_id* refers to a
    code-layer node (Function, Class, Variable, File, Directory,
    Repository).

    Fallback: if the literal traversal is empty AND *entity_id* refers
    to a code-layer node, this function strips any trailing Python
    signature from the symbol's name (so ``field_validator(str, …)`` →
    ``field_validator``) and then looks up entity-layer nodes whose
    name *contains* the bare symbol name as a case-insensitive
    substring. This handles real-world extraction patterns where the
    entity ends up as ``"field_validator decorator"`` or
    ``"@field_validator"`` rather than a strict equality match. The
    MENTIONS pages from every matching entity are unioned and
    deduplicated by id. The direct branch short-circuits the fallback,
    so callers get one path or the other, not both.

    Returns a list of WikiPage node payloads. Empty list if nothing
    matches.
    """
    # Look up the node first so we can (a) bail cleanly on unknown ids
    # without a traversal error and (b) reuse its type/name for the
    # fallback branch without a second get_node call.
    node = store.get_node(entity_id)
    if not node:
        return []

    direct = _mentions_to_pages(store, entity_id)
    if direct:
        return direct

    # Fallback: code-layer id → entity-layer name match → traverse.
    if (node.get("type") or "") not in DOMAINS["code"]:
        return []
    raw_name = (node.get("name") or "").strip()
    # Strip a trailing Python signature so extractor names like
    # ``field_validator(str, ...)`` reduce to ``field_validator``.
    bare = _strip_signature(raw_name)
    if not bare:
        return []

    # Look up entity-layer nodes by the bare name. ``store.list_nodes
    # (filters=...)`` filters the ``properties`` dict, not the top-level
    # ``name`` column, so we use ``search_nodes`` (name-indexed FTS) and
    # then enforce case-insensitive substring containment. Substring (not
    # strict equality) handles real-world extraction patterns where
    # entities pick up natural-language suffixes like
    # ``"field_validator decorator"`` or prefixes like ``"@field_validator"``.
    bare_lower = bare.lower()
    candidates = store.search_nodes(bare, node_types=list(DOMAINS["entity"]), limit=50)
    matches = [c for c in candidates if bare_lower in (c.get("name") or "").lower()]

    seen: set[str] = set()
    fallback: list[dict[str, Any]] = []
    for ent in matches:
        for page in _mentions_to_pages(store, ent["id"]):
            pid = page.get("id")
            if pid and pid not in seen:
                seen.add(pid)
                fallback.append(page)
    return fallback


def find_entities_mentioned_by(store: GraphStore, page_id: str) -> list[dict[str, Any]]:
    """Return entity nodes a WikiPage MENTIONS.

    Catches every entity-typed node — Idea / Service / Module / Paper /
    Person / Event — that the page's body referenced. ``page_id`` should
    be a WikiPage; passing other node types returns the (likely empty)
    outgoing MENTIONS set for whatever the node happens to be.

    Common chained workflow: call ``find_pages_mentioning`` on a code
    symbol first to surface the relevant pages, then call this on each
    result to see what other entities those pages connect to.
    """
    outgoing = store.traverse(page_id, direction="outgoing", max_depth=1, relationship_type="MENTIONS")
    return [r["node"] for r in outgoing if r.get("node")]


def _mentions_to_pages(store: GraphStore, node_id: str) -> list[dict[str, Any]]:
    """Internal: incoming MENTIONS traversal, filtered to WikiPage nodes."""
    incoming = store.traverse(node_id, direction="incoming", max_depth=1, relationship_type="MENTIONS")
    return [r["node"] for r in incoming if r.get("node", {}).get("type") == "WikiPage"]
