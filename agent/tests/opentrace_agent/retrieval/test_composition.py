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

"""End-to-end OT-1732 composition smoke tests.

The OT-1732 success criterion is: an agent can answer non-trivial questions
about a codebase + its surrounding documentation by *composing* the seven
retrieval primitives. We don't drive an LLM here — we drive a deterministic
fixture chain that proves each composition step terminates with the expected
shape and the final hop carries the data the agent would need.
"""

from __future__ import annotations

import pytest

ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.retrieval import (  # noqa: E402
    count_by,
    find_orphans,
    find_path,
    find_via_relationship_to_type,
    overview,
    provenance,
    search,
)
from opentrace_agent.store import GraphStore  # noqa: E402
from opentrace_agent.wiki.ingest.graph_writer import (  # noqa: E402
    vault_node_id,
    write_vault_to_graph,
)
from opentrace_agent.wiki.vault import IngestedSource, PageMeta, VaultMetadata  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    s = GraphStore(str(tmp_path / "compdb"))
    yield s
    s.close()


@pytest.fixture()
def seeded_store(store):
    """A small graph spanning code + wiki domains.

    Code:
      Repository(myorg/api) -CONTAINS-> File(server.py) -CONTAINS-> Function(handle)
      Function(handle) -CALLS-> Function(authenticate)

    Wiki:
      Vault(kb) -CONTAINS-> WikiPage(auth-flow)
      Vault(kb) -CONTAINS-> Source(spec.pdf)
      WikiPage(auth-flow) -CITES-> Source(spec.pdf)

    IndexMetadata for myorg/api with commit_sha + indexer_version.
    """
    # --- Code side ---
    store.add_node("myorg/api", "Repository", "api", {"local_path": "/tmp/api-fixture"})
    store.add_node(
        "myorg/api/src/server.py",
        "File",
        "server.py",
        {"path": "src/server.py"},
    )
    store.add_node(
        "myorg/api/src/server.py::handle",
        "Function",
        "handle",
        {"path": "src/server.py", "start_line": 10, "end_line": 25},
    )
    store.add_node(
        "myorg/api/src/server.py::authenticate",
        "Function",
        "authenticate",
        {"path": "src/server.py", "start_line": 30, "end_line": 40},
    )
    store.add_relationship("c1", "CONTAINS", "myorg/api", "myorg/api/src/server.py")
    store.add_relationship("c2", "CONTAINS", "myorg/api/src/server.py", "myorg/api/src/server.py::handle")
    store.add_relationship("c3", "CONTAINS", "myorg/api/src/server.py", "myorg/api/src/server.py::authenticate")
    store.add_relationship(
        "call1",
        "CALLS",
        "myorg/api/src/server.py::handle",
        "myorg/api/src/server.py::authenticate",
        properties={"confidence": 0.95},
    )
    store.save_metadata(
        {
            "repoId": "myorg/api",
            "commitSha": "deadbeef",
            "opentraceaiVersion": "0.4.0",
            "indexedAt": "2026-04-30T12:00:00",
        }
    )

    # --- Wiki side ---
    meta = VaultMetadata.empty(name="kb")
    meta.last_compiled_at = "2026-05-01T00:00:00+00:00"
    meta.sources = {
        "spec-sha": IngestedSource(
            sha256="spec-sha",
            original_name="spec.pdf",
            ingested_at="2026-05-01T00:00:00",
        ),
    }
    meta.pages = {
        "concept/auth-flow": PageMeta(
            slug="concept/auth-flow",
            title="Auth Flow",
            one_line_summary="How requests authenticate against the spec.",
            source_shas=["spec-sha"],
            last_updated="2026-05-01T00:00:00",
            revision=1,
            kind="concept",
        ),
    }
    bodies = {
        "concept/auth-flow": "Auth flow verifies tokens against the OAuth spec.",
    }
    write_vault_to_graph(
        store,
        meta,
        bodies,
        provenance={
            "agent": "opentrace-wiki-compiler",
            "model": "claude-opus-4-7",
            "session": "test-session",
            "confidence": 0.0,
        },
        compiled_slugs={"concept/auth-flow"},
    )

    return store


# ---------------------------------------------------------------------------
# Cross-domain composition
# ---------------------------------------------------------------------------


class TestSessionStartOrientation:
    """Phase-3 success criterion: overview gives the agent enough to triage.

    Composition: agent calls overview as session start, picks a top concept,
    then drills in via search/get_node.
    """

    def test_overview_lists_both_domains(self, seeded_store):
        result = overview(seeded_store, top_n=10)
        types = result["counts_by_type"]
        # Code side present
        assert "Repository" in types
        assert "Function" in types
        # Wiki side present
        assert "WikiVault" in types
        assert "WikiPage" in types
        assert "CorpusDoc" in types
        # Vault scope is null when not requested.
        assert result["vault_scope"] is None

    def test_overview_vault_scope_excludes_code(self, seeded_store):
        result = overview(seeded_store, top_n=10, vault_scope="kb")
        types = result["counts_by_type"]
        # Only vault-domain types appear under vault scope.
        assert set(types).issubset({"WikiVault", "WikiPage", "CorpusDoc"})
        assert result["vault_scope"] == "kb"


class TestWikiCitationChain:
    """Phase-5 success criterion: the agent can trace a wiki claim back to
    its source via the provenance chain."""

    def test_search_finds_concept_and_provenance_walks_to_source(self, seeded_store):
        # 1. Agent searches for the topic.
        s = search(seeded_store, "auth flow", limit=5)
        assert s["count"] >= 1
        hits = [h for h in s["hits"] if h["type"] == "WikiPage"]
        assert hits, "expected a WikiPage hit"
        page_id = hits[0]["id"]

        # 2. Agent asks for provenance.
        p = provenance(seeded_store, page_id)
        assert p["kind"] == "wiki"
        assert p["wiki"]["agent"] == "opentrace-wiki-compiler"
        assert p["wiki"]["model"] == "claude-opus-4-7"

        # 3. Chain terminates at a Source node carrying sha + filename.
        sources = [c for c in p["wiki"]["chain"] if c["kind"] == "corpus_doc"]
        assert sources, "provenance chain must reach at least one Source"
        assert sources[0]["sha256"] == "spec-sha"
        assert sources[0]["filename"] == "spec.pdf"


class TestCodeImpactQuery:
    """Phase-2/3 success criterion: typed structural queries answer
    blast-radius / impact questions."""

    def test_find_path_traces_call_chain(self, seeded_store):
        result = find_path(
            seeded_store,
            "myorg/api/src/server.py::handle",
            "myorg/api/src/server.py::authenticate",
            edge_types=["CALLS"],
        )
        assert result["length"] == 1
        assert result["path"][-1]["node"]["id"] == "myorg/api/src/server.py::authenticate"

    def test_find_via_returns_typed_cross_reference(self, seeded_store):
        result = find_via_relationship_to_type(seeded_store, "Function", "CALLS", "Function")
        assert result["count"] == 1
        pair = result["pairs"][0]
        assert pair["start"]["name"] == "handle"
        assert pair["target"]["name"] == "authenticate"

    def test_find_orphans_flags_uncalled_function(self, seeded_store):
        # `authenticate` IS called from `handle`; `handle` itself has no
        # incoming CALLS — so find_orphans should surface it.
        result = find_orphans(seeded_store, "Function", "CALLS", direction="incoming")
        ids = {o["id"] for o in result["orphans"]}
        assert "myorg/api/src/server.py::handle" in ids
        assert "myorg/api/src/server.py::authenticate" not in ids


class TestCodeProvenanceJoin:
    """Phase-5 success criterion: code provenance answers
    'where did this come from' for indexed code."""

    def test_provenance_joins_code_node_with_repo_metadata(self, seeded_store):
        p = provenance(seeded_store, "myorg/api/src/server.py::handle")
        assert p["kind"] == "code"
        assert p["code"]["commit_sha"] == "deadbeef"
        assert p["code"]["indexer_version"] == "0.4.0"
        assert p["code"]["file_path"] == "src/server.py"
        assert p["code"]["line_range"] == [10, 25]


class TestVaultGraphCounts:
    """count_by sanity for the new vault types."""

    def test_count_by_under_vault(self, seeded_store):
        result = count_by(
            seeded_store,
            "WikiPage",
            parent_id=vault_node_id("kb"),
            parent_edge="CONTAINS",
            max_hops=1,
        )
        assert result["count"] == 1
