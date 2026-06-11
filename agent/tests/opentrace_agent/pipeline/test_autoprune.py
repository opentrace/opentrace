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

"""Tests for the autoprune pass (Phase 4 of the ingestion unification)."""

from __future__ import annotations

import pytest

pytest.importorskip("real_ladybug")

from opentrace_agent.pipeline.autoprune import (  # noqa: E402
    autoprune_after_index,
    compute_walked_shas,
)
from opentrace_agent.store import GraphStore  # noqa: E402
from opentrace_agent.wiki.ingest.graph_writer import vault_node_id  # noqa: E402


def _seed(store: GraphStore, vault: str = "v") -> dict[str, str]:
    """Seed a small graph: 3 Sources, 1 file_summary page each + 1 concept page citing all three.

    Mirrors the real graph the wiki pipeline writes: a ``WikiVault`` node owns
    its Sources and pages via ``CONTAINS`` edges. Autoprune discovers in-scope
    Sources by traversing ``WikiVault -CONTAINS-> Source`` (sources are
    content-addressed and carry no single vault), so the vault node + edges
    are what makes a source visible to the prune pass.
    """
    sids = {}
    # WikiVault node — the discovery anchor for this vault.
    vault_id = vault_node_id(vault)
    store.add_node(vault_id, "WikiVault", vault, properties={"vault": vault, "scope": "local"})
    for i, sha in enumerate(["aaa", "bbb", "ccc"]):
        sid = f"source::{sha}"
        sids[sha] = sid
        store.add_node(
            sid,
            "Source",
            f"file{i}.md",
            properties={
                "sha256": sha,
                "filename": f"file{i}.md",
                "corpus_path": f"corpus/source__{sha}.md",
            },
        )
        store.add_relationship(f"{vault_id}->CONTAINS->{sid}", "CONTAINS", vault_id, sid, properties={"vault": vault})
        # file_summary 1:1
        page_id = f"{vault}::summary-{sha}"
        store.add_node(
            page_id,
            "WikiPage",
            f"Summary {i}",
            properties={"vault": vault, "slug": f"summary-{sha}", "kind": "file_summary"},
        )
        store.add_relationship(
            f"{vault_id}->CONTAINS->{page_id}", "CONTAINS", vault_id, page_id, properties={"vault": vault}
        )
        store.add_relationship(f"{page_id}->CITES->{sid}", "CITES", page_id, sid, properties={"vault": vault})

    # Concept page citing all three sources.
    concept_id = f"{vault}::concept-x"
    store.add_node(
        concept_id,
        "WikiPage",
        "Concept X",
        properties={"vault": vault, "slug": "concept-x", "kind": "concept"},
    )
    store.add_relationship(
        f"{vault_id}->CONTAINS->{concept_id}", "CONTAINS", vault_id, concept_id, properties={"vault": vault}
    )
    for sid in sids.values():
        store.add_relationship(f"{concept_id}->CITES->{sid}", "CITES", concept_id, sid, properties={"vault": vault})

    # An entity derived from one of the sources.
    store.add_node(
        "idea_thing",
        "Idea",
        "Thing",
        properties={"vault": vault, "derived_from": sids["aaa"]},
    )
    store.add_relationship(
        "derived:idea_thing->source::aaa",
        "DERIVED_FROM",
        "idea_thing",
        sids["aaa"],
        properties={"transform": "llm_extraction"},
    )
    return sids


class TestAutoprune:
    def test_orphan_source_deleted(self, tmp_path):
        with GraphStore(str(tmp_path / "db")) as store:
            sids = _seed(store)

            # Re-walk sees aaa and bbb but NOT ccc (it was removed from disk).
            report = autoprune_after_index(
                store,
                walked_doc_shas={"aaa", "bbb"},
                walked_file_ids=set(),
                vault_name="v",
                scope_path=tmp_path,
                db_path=str(tmp_path / "db"),
            )

            assert report.sources_deleted == 1
            assert store.get_node(sids["ccc"]) is None
            # Other two sources stay.
            assert store.get_node(sids["aaa"]) is not None
            assert store.get_node(sids["bbb"]) is not None

    def test_file_summary_page_deleted_when_source_removed(self, tmp_path):
        with GraphStore(str(tmp_path / "db")) as store:
            _seed(store)
            autoprune_after_index(
                store,
                walked_doc_shas={"aaa", "bbb"},
                walked_file_ids=set(),
                vault_name="v",
                scope_path=tmp_path,
                db_path=str(tmp_path / "db"),
            )
            # The summary page 1:1 with the removed source is gone.
            assert store.get_node("v::summary-ccc") is None
            # The other two summary pages stay.
            assert store.get_node("v::summary-aaa") is not None
            assert store.get_node("v::summary-bbb") is not None

    def test_concept_page_marked_stale_when_one_citation_lost(self, tmp_path):
        with GraphStore(str(tmp_path / "db")) as store:
            _seed(store)
            autoprune_after_index(
                store,
                walked_doc_shas={"aaa", "bbb"},  # ccc removed
                walked_file_ids=set(),
                vault_name="v",
                scope_path=tmp_path,
                db_path=str(tmp_path / "db"),
            )
            concept = store.get_node("v::concept-x")
            assert concept is not None
            # Stale_since stamped — page kept, no regen.
            assert concept["properties"].get("stale_since")

    def test_concept_page_deleted_when_all_citations_lost(self, tmp_path):
        with GraphStore(str(tmp_path / "db")) as store:
            _seed(store)
            # Remove ALL sources from the walk → concept page has no remaining
            # citations → page itself gets deleted.
            autoprune_after_index(
                store,
                walked_doc_shas=set(),
                walked_file_ids=set(),
                vault_name="v",
                scope_path=tmp_path,
                db_path=str(tmp_path / "db"),
            )
            assert store.get_node("v::concept-x") is None

    def test_orphan_entity_deleted_when_source_removed(self, tmp_path):
        with GraphStore(str(tmp_path / "db")) as store:
            _seed(store)
            autoprune_after_index(
                store,
                walked_doc_shas={"bbb", "ccc"},  # aaa removed
                walked_file_ids=set(),
                vault_name="v",
                scope_path=tmp_path,
                db_path=str(tmp_path / "db"),
            )
            # idea_thing derived only from aaa (now removed) → deleted.
            assert store.get_node("idea_thing") is None

    def test_scope_safety_other_vaults_untouched(self, tmp_path):
        with GraphStore(str(tmp_path / "db")) as store:
            _seed(store, vault="v1")
            _seed(store, vault="v2")
            # Autoprune scoped to v1 only — v2's vault-specific pages must
            # survive. Note: ``_seed`` uses the same sha-keyed Source ids
            # in both vaults (same content sha = same id), so Source nodes
            # are shared rather than duplicated; the *second* _seed wins
            # on vault tagging, which is a real edge case worth noting but
            # not what this test exercises. The test asserts the
            # vault-specific WikiPage nodes survive intact.
            autoprune_after_index(
                store,
                walked_doc_shas=set(),  # all of v1 walked away from disk
                walked_file_ids=set(),
                vault_name="v1",
                scope_path=tmp_path,
                db_path=str(tmp_path / "db"),
            )
            # v2's vault-specific pages survive.
            assert store.get_node("v2::concept-x") is not None
            assert store.get_node("v2::summary-aaa") is not None
            assert store.get_node("v2::summary-bbb") is not None


class TestComputeWalkedShas:
    def test_hashes_raw_file_bytes(self, tmp_path):
        f1 = tmp_path / "a.md"
        f1.write_bytes(b"hello")
        f2 = tmp_path / "b.md"
        f2.write_bytes(b"world")

        shas = compute_walked_shas([f1, f2])
        # Both must be present.
        assert len(shas) == 2
        # Each is a 64-char hex sha.
        for sha in shas:
            assert len(sha) == 64
            assert all(c in "0123456789abcdef" for c in sha)
