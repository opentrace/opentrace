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

"""Tests for ``retrieval.cross_cutting`` — the MENTIONS-traversal helpers
plus the code-symbol → entity-name fallback in ``find_pages_mentioning``.
"""

from __future__ import annotations

import pytest

ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.retrieval.cross_cutting import (  # noqa: E402
    find_entities_mentioned_by,
    find_pages_mentioning,
)
from opentrace_agent.store import GraphStore  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    s = GraphStore(str(tmp_path / "ccdb"))
    yield s
    s.close()


@pytest.fixture()
def seeded(store):
    """Fixture covering both direct entity hits and the code-symbol fallback.

    * Entity ``Idea("AuthMiddleware")`` is what MENTIONS edges actually target.
    * Function ``auth.py::AuthMiddleware`` has the same ``name`` as the entity
      but no MENTIONS edges of its own — exercises the fallback path.
    * Two WikiPages MENTIONS the entity; one unrelated page mentions nothing.
    """
    # Code symbol (no MENTIONS edges)
    store.add_node(
        "myorg/repo/auth.py::AuthMiddleware",
        "Function",
        "AuthMiddleware",
        {"path": "auth.py", "start_line": 10, "end_line": 30},
    )
    # Entity matching the code symbol by name — this is what MENTIONS hit
    store.add_node("idea:AuthMiddleware", "Idea", "AuthMiddleware", {})

    # Wiki pages
    store.add_node(
        "vault::concept/auth-flow",
        "WikiPage",
        "Auth Flow",
        {"slug": "concept/auth-flow", "vault": "vault", "kind": "concept"},
    )
    store.add_node(
        "vault::concept/sessions",
        "WikiPage",
        "Sessions",
        {"slug": "concept/sessions", "vault": "vault", "kind": "concept"},
    )
    store.add_node(
        "vault::concept/unrelated",
        "WikiPage",
        "Unrelated",
        {"slug": "concept/unrelated", "vault": "vault", "kind": "concept"},
    )

    # Pages MENTIONS the entity (not the code symbol directly)
    store.add_relationship("m1", "MENTIONS", "vault::concept/auth-flow", "idea:AuthMiddleware")
    store.add_relationship("m2", "MENTIONS", "vault::concept/sessions", "idea:AuthMiddleware")
    return store


def test_direct_entity_hit_returns_pages(seeded):
    pages = find_pages_mentioning(seeded, "idea:AuthMiddleware")
    ids = sorted(p["id"] for p in pages)
    assert ids == ["vault::concept/auth-flow", "vault::concept/sessions"]


def test_code_symbol_fallback_resolves_via_name(seeded):
    """A code-layer node with no MENTIONS should fall back to an entity-layer
    node sharing the same ``name`` and return THAT entity's pages."""
    pages = find_pages_mentioning(seeded, "myorg/repo/auth.py::AuthMiddleware")
    ids = sorted(p["id"] for p in pages)
    assert ids == ["vault::concept/auth-flow", "vault::concept/sessions"]


def test_unknown_id_returns_empty(seeded):
    assert find_pages_mentioning(seeded, "no-such-node") == []


def test_code_symbol_without_name_match_returns_empty(seeded):
    """Code symbol whose name doesn't match any entity → empty, not random."""
    seeded.add_node("myorg/repo/other.py::Nobody", "Function", "Nobody", {})
    assert find_pages_mentioning(seeded, "myorg/repo/other.py::Nobody") == []


def test_direct_hit_short_circuits_fallback(seeded):
    """If the literal traversal finds anything, the fallback should not fire
    — even if there are other name-matched entities lurking."""
    # Wire a second Idea with the same name but no MENTIONS edges — it should
    # not contribute to the result because the direct branch already returned.
    seeded.add_node("idea:AuthMiddleware-alt", "Idea", "AuthMiddleware", {})
    pages = find_pages_mentioning(seeded, "idea:AuthMiddleware")
    ids = sorted(p["id"] for p in pages)
    # Same two pages as the basic direct-hit case; no duplication, no extras.
    assert ids == ["vault::concept/auth-flow", "vault::concept/sessions"]


def test_find_entities_mentioned_by_returns_outgoing_entities(seeded):
    entities = find_entities_mentioned_by(seeded, "vault::concept/auth-flow")
    ids = [e.get("id") for e in entities]
    types = [e.get("type") for e in entities]
    assert "idea:AuthMiddleware" in ids
    assert "Idea" in types


def test_signature_stripping_and_substring_match(store):
    """Real-world pattern: extractor stores a Function with its signature
    appended (``field_validator(str, …)``), while the matching entity got
    extracted with a natural-language suffix (``field_validator decorator``)
    or a prefix (``@field_validator``). The fallback must strip the
    signature and then substring-match on entity names — not require
    strict equality — to bridge them.
    """
    # Code symbol with signature suffix, no MENTIONS edges
    fn_id = "pydantic/functional_validators.py::field_validator(str,str,Literal['wrap'],bool|None,Any)"
    store.add_node(
        fn_id,
        "Function",
        "field_validator(str,str,Literal['wrap'],bool|None,Any)",
        {"path": "functional_validators.py"},
    )
    # Two entity nodes that share the bare name as a substring
    store.add_node("idea:fv-decorator", "Idea", "field_validator decorator", {})
    store.add_node("idea:fv-at", "Idea", "@field_validator", {})
    # A third entity that should NOT match (different bare name)
    store.add_node("idea:unrelated", "Idea", "model_validator", {})
    # Wiki pages
    store.add_node(
        "vault::concept/validators",
        "WikiPage",
        "Validators",
        {"slug": "concept/validators", "vault": "vault", "kind": "concept"},
    )
    store.add_node(
        "vault::concept/decorators",
        "WikiPage",
        "Decorators",
        {"slug": "concept/decorators", "vault": "vault", "kind": "concept"},
    )
    store.add_node(
        "vault::concept/models",
        "WikiPage",
        "Models",
        {"slug": "concept/models", "vault": "vault", "kind": "concept"},
    )
    # Pages mention the two matching entities — not the code symbol directly
    store.add_relationship("m1", "MENTIONS", "vault::concept/validators", "idea:fv-decorator")
    store.add_relationship("m2", "MENTIONS", "vault::concept/decorators", "idea:fv-at")
    # The unrelated entity is mentioned by a third page — should NOT appear
    store.add_relationship("m3", "MENTIONS", "vault::concept/models", "idea:unrelated")

    pages = find_pages_mentioning(store, fn_id)
    ids = sorted(p["id"] for p in pages)
    assert ids == ["vault::concept/decorators", "vault::concept/validators"], (
        f"expected both matching-entity pages, got {ids!r}"
    )
