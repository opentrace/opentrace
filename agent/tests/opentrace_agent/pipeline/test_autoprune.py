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
    """Seed a small graph: a Vault node owning three KnowledgeDocs.

    Mirrors the real graph the wiki pipeline writes. Autoprune discovers
    in-scope documents by traversing ``Vault -CONTAINS-> KnowledgeDoc``
    (documents are content-addressed and carry no single vault), so the vault
    node + edges are what makes a document visible to the prune pass.

    This used to also seed concept pages and their ``CITES`` edges, because
    autoprune had a second sweep that deleted a page losing its last citation
    and stamped ``stale_since`` on one that kept some. Both went with the
    concept-page layer on 2026-08-04 — nothing synthesized pages, so nothing
    could go stale.
    """
    sids = {}
    # Vault node — the discovery anchor for this vault.
    vault_id = vault_node_id(vault)
    store.add_node(vault_id, "KnowledgeVault", vault, properties={"vault": vault, "scope": "local"})
    for i, sha in enumerate(["aaa", "bbb", "ccc"]):
        sid = f"corpus::{sha}"
        sids[sha] = sid
        store.add_node(
            sid,
            "KnowledgeDoc",
            f"file{i}.md",
            properties={
                "sha256": sha,
                "filename": f"file{i}.md",
                "corpus_path": f"corpus/source__{sha}.md",
            },
        )
        store.add_relationship(f"{vault_id}->CONTAINS->{sid}", "CONTAINS", vault_id, sid, properties={"vault": vault})
    return sids


class TestAutoprune:
    def test_orphan_source_deleted(self, tmp_path):
        with GraphStore(str(tmp_path / "db")) as store:
            sids = _seed(store)

            # Re-walk sees aaa and bbb but NOT ccc (it was removed from disk).
            report = autoprune_after_index(
                store,
                walked_doc_shas={"aaa", "bbb"},
                vault_name="v",
                db_path=str(tmp_path / "db"),
            )

            assert report.documents_deleted == 1
            assert store.get_node(sids["ccc"]) is None
            # Other two sources stay.
            assert store.get_node(sids["aaa"]) is not None
            assert store.get_node(sids["bbb"]) is not None

    def test_all_orphans_deleted_when_nothing_walked(self, tmp_path):
        with GraphStore(str(tmp_path / "db")) as store:
            sids = _seed(store)
            report = autoprune_after_index(
                store,
                walked_doc_shas=set(),
                vault_name="v",
                db_path=str(tmp_path / "db"),
            )
            assert report.documents_deleted == 3
            assert all(store.get_node(sid) is None for sid in sids.values())
            # The vault node itself is not a prune target — `vault delete` owns that.
            assert store.get_node(vault_node_id("v")) is not None

    def test_report_carries_only_document_counters(self, tmp_path):
        """The page counters (``pages_deleted`` / ``pages_marked_stale`` /
        ``cites_edges_removed``) went with the layer; the CLI summary reads
        this dataclass, so a resurrected field would print a line about a
        thing that cannot happen."""
        from dataclasses import fields

        from opentrace_agent.pipeline.autoprune import AutopruneReport

        assert {f.name for f in fields(AutopruneReport)} == {
            "documents_deleted",
            "corpus_files_deleted",
        }

    def test_scope_safety_other_vaults_untouched(self, tmp_path):
        with GraphStore(str(tmp_path / "db")) as store:
            _seed(store, vault="v1")
            # A second vault with its OWN documents (different shas — sharing a
            # sha means sharing one content-addressed node, which is a separate
            # concern from vault scoping).
            v2 = vault_node_id("v2")
            store.add_node(v2, "KnowledgeVault", "v2", properties={"vault": "v2", "scope": "local"})
            for sha in ("ddd", "eee"):
                sid = f"corpus::{sha}"
                store.add_node(sid, "KnowledgeDoc", f"{sha}.md", properties={"sha256": sha})
                store.add_relationship(f"{v2}->CONTAINS->{sid}", "CONTAINS", v2, sid)

            autoprune_after_index(
                store,
                walked_doc_shas=set(),  # all of v1 walked away from disk
                vault_name="v1",
                db_path=str(tmp_path / "db"),
            )
            # v2's documents survive — the prune never left v1's CONTAINS set.
            assert store.get_node("corpus::ddd") is not None
            assert store.get_node("corpus::eee") is not None


class TestCorpusFileDeletion:
    """``corpus_path`` is graph data on a path that ends in ``unlink()``."""

    def test_deletes_body_at_db_relative_corpus_path(self, tmp_path):
        """``corpus_path`` is stored relative to the DB's parent, so it resolves
        against that directory — not against a ``corpus/`` subdirectory, which
        would double the segment and silently delete nothing."""
        db = tmp_path / ".opentrace" / "index.db"
        db.parent.mkdir(parents=True)
        body = db.parent / "corpus" / "source__ccc.md"
        body.parent.mkdir()
        body.write_text("orphan body")

        with GraphStore(str(db)) as store:
            _seed(store)
            report = autoprune_after_index(
                store,
                walked_doc_shas={"aaa", "bbb"},
                vault_name="v",
                db_path=str(db),
            )

        assert report.corpus_files_deleted == 1
        assert not body.exists()

    def test_traversing_corpus_path_is_refused(self, tmp_path):
        """A ``corpus_path`` that escapes the DB directory must not be unlinked.
        The value comes from the graph, which is written from whatever was
        ingested — so it is untrusted input to a delete."""
        db = tmp_path / ".opentrace" / "index.db"
        db.parent.mkdir(parents=True)
        victim = tmp_path / "precious.txt"
        victim.write_text("do not delete me")

        with GraphStore(str(db)) as store:
            vault_id = vault_node_id("v")
            store.add_node(vault_id, "KnowledgeVault", "v", properties={"vault": "v", "scope": "local"})
            sid = "corpus::evil"
            store.add_node(
                sid,
                "KnowledgeDoc",
                "evil.md",
                properties={"sha256": "evil", "corpus_path": "../precious.txt"},
            )
            store.add_relationship(f"{vault_id}->CONTAINS->{sid}", "CONTAINS", vault_id, sid)

            report = autoprune_after_index(
                store,
                walked_doc_shas=set(),  # the doc is an orphan → prune target
                vault_name="v",
                db_path=str(db),
            )

        assert victim.exists(), "path-traversal corpus_path escaped the DB directory"
        assert report.corpus_files_deleted == 0
        # The node itself is still pruned — only the file delete is refused.
        assert report.documents_deleted == 1


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
