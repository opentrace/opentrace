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

"""Tests for cross-document entity merge."""

from __future__ import annotations

from opentrace_agent.pipeline.entity_merge import (
    MergeStats,
    canonical_key,
    merge_entities,
)
from opentrace_agent.pipeline.types import GraphNode, GraphRelationship


def _node(node_id: str, type_: str, name: str, **props):
    return GraphNode(id=node_id, type=type_, name=name, properties=props or None)


def _derived(src_id: str, file_id: str) -> GraphRelationship:
    return GraphRelationship(
        id=f"derived:{src_id}->{file_id}",
        type="DERIVED_FROM",
        source_id=src_id,
        target_id=file_id,
        properties={"transform": "llm_extraction"},
    )


def _sem(src: str, tgt: str, relation: str, score: float = 0.85) -> GraphRelationship:
    return GraphRelationship(
        id=f"se:{src}:{tgt}:{relation}",
        type="SEMANTIC_EDGE",
        source_id=src,
        target_id=tgt,
        properties={
            "relation": relation,
            "confidence": "INFERRED",
            "confidence_score": score,
        },
    )


class TestCanonicalKey:
    def test_lowercases(self):
        assert canonical_key("Autoprune") == "autoprune"
        assert canonical_key("AUTOPRUNE") == "autoprune"

    def test_strips_parentheticals(self):
        assert canonical_key("Autoprune (stale-page stamping)") == "autoprune"
        assert canonical_key("Foo (bar) (baz)") == "foo"

    def test_collapses_punctuation_and_whitespace(self):
        assert canonical_key("auto-prune") == "auto prune"
        assert canonical_key("auto_prune") == "auto prune"
        assert canonical_key("  Auto   Prune  ") == "auto prune"

    def test_distinct_concepts_keep_distinct_keys(self):
        assert canonical_key("Knowledge Graph") != canonical_key("Graph")


class TestSameNameMerge:
    def test_same_name_same_type_merges(self):
        nodes = [
            _node("cli_flags_autoprune", "Idea", "Autoprune", source_uri="cli-flags.md"),
            _node("overview_autoprune", "Idea", "Autoprune", source_uri="overview.md"),
            _node("wiki_autoprune", "Idea", "Autoprune", source_uri="wiki.md"),
        ]
        out_nodes, _, stats = merge_entities(nodes, [])
        assert len(out_nodes) == 1
        assert stats.nodes_merged == 2
        assert stats.groups_considered == 1

    def test_case_variants_merge(self):
        nodes = [
            _node("a_autoprune", "Idea", "Autoprune"),
            _node("b_autoprune", "Idea", "autoprune"),
            _node("c_autoprune", "Idea", "AUTOPRUNE"),
        ]
        out_nodes, _, stats = merge_entities(nodes, [])
        assert len(out_nodes) == 1
        assert stats.nodes_merged == 2

    def test_parenthetical_clarification_merges(self):
        nodes = [
            _node("a_autoprune", "Idea", "Autoprune"),
            _node("b_autoprune", "Idea", "Autoprune (stale-page stamping on source removal)"),
        ]
        out_nodes, _, stats = merge_entities(nodes, [])
        assert len(out_nodes) == 1
        # Canonical = longest label.
        assert out_nodes[0].name == "Autoprune (stale-page stamping on source removal)"
        assert stats.nodes_merged == 1


class TestCrossTypeMerge:
    def test_same_name_different_type_merges(self):
        """Per-doc extraction types the same referent inconsistently
        (Werkzeug: Service in the changelog, Module in the deploy guide) —
        cross-type merge collapses them so MENTIONS/DERIVED_FROM aren't
        double-counted."""
        nodes = [
            _node("changes_werkzeug", "Service", "Werkzeug"),
            _node("deploy_werkzeug", "Module", "Werkzeug"),
        ]
        out_nodes, _, stats = merge_entities(nodes, [])
        assert len(out_nodes) == 1
        assert stats.nodes_merged == 1
        assert stats.groups_considered == 1

    def test_type_resolved_by_majority(self):
        nodes = [
            _node("a_jinja", "Module", "Jinja"),
            _node("b_jinja", "Module", "Jinja"),
            _node("c_jinja", "Service", "Jinja"),
        ]
        out_nodes, _, _ = merge_entities(nodes, [])
        assert len(out_nodes) == 1
        assert out_nodes[0].type == "Module"

    def test_type_tie_breaks_by_precedence(self):
        # 1-1 Service/Idea split: the concrete type (Service) wins the tie.
        nodes = [
            _node("a_click", "Idea", "Click"),
            _node("b_click", "Service", "Click"),
        ]
        out_nodes, _, _ = merge_entities(nodes, [])
        assert len(out_nodes) == 1
        assert out_nodes[0].type == "Service"

    def test_canonical_id_matches_resolved_type(self):
        # The surviving node comes from a member OF the winning type, so id
        # and properties stay consistent with it.
        nodes = [
            _node("a_jinja", "Module", "Jinja"),
            _node("b_jinja", "Module", "Jinja"),
            _node("c_jinja", "Service", "Jinja"),
        ]
        out_nodes, _, _ = merge_entities(nodes, [])
        assert out_nodes[0].id in ("a_jinja", "b_jinja")

    def test_person_never_merges_with_non_person(self):
        """A person sharing a name with a product must stay distinct."""
        nodes = [
            _node("cli_click", "Service", "Click"),
            _node("people_click", "Person", "Click"),
        ]
        out_nodes, _, stats = merge_entities(nodes, [])
        assert len(out_nodes) == 2
        assert stats.nodes_merged == 0
        assert sorted(n.type for n in out_nodes) == ["Person", "Service"]

    def test_persons_still_merge_with_each_other(self):
        nodes = [
            _node("a_karen", "Person", "Karen Chen"),
            _node("b_karen", "Person", "Karen Chen"),
        ]
        out_nodes, _, stats = merge_entities(nodes, [])
        assert len(out_nodes) == 1
        assert stats.nodes_merged == 1

    def test_mergeable_and_pass_through_coexist(self):
        nodes = [
            _node("a_foo", "Idea", "Foo"),
            _node("b_foo", "Idea", "Foo"),
            _node("file_x", "File", "x.py"),
            _node("func_x_main", "Function", "main"),
        ]
        out_nodes, _, stats = merge_entities(nodes, [])
        # Pass-through nodes unchanged; Idea group collapses.
        assert len(out_nodes) == 3
        assert stats.nodes_merged == 1
        types = sorted(n.type for n in out_nodes)
        assert types == ["File", "Function", "Idea"]


class TestEdgeRewrite:
    def test_derived_from_edges_preserve_multi_source(self):
        # Same concept named in 3 files: 3 DERIVED_FROM edges to 3 different files.
        nodes = [
            _node("a_x", "Idea", "X"),
            _node("b_x", "Idea", "X"),
            _node("c_x", "Idea", "X"),
            _node("file_a", "File", "a.md"),
            _node("file_b", "File", "b.md"),
            _node("file_c", "File", "c.md"),
        ]
        rels = [
            _derived("a_x", "file_a"),
            _derived("b_x", "file_b"),
            _derived("c_x", "file_c"),
        ]
        out_nodes, out_rels, stats = merge_entities(nodes, rels)
        idea_nodes = [n for n in out_nodes if n.type == "Idea"]
        assert len(idea_nodes) == 1
        canonical_id = idea_nodes[0].id
        # All 3 DERIVED_FROM should now point from the canonical to the
        # respective file. None should be dropped.
        derived_rels = [r for r in out_rels if r.type == "DERIVED_FROM"]
        assert len(derived_rels) == 3
        assert {r.target_id for r in derived_rels} == {"file_a", "file_b", "file_c"}
        assert all(r.source_id == canonical_id for r in derived_rels)
        assert stats.edges_rewritten == 2  # 2 edges had their source rewritten

    def test_semantic_edges_collapse_keep_highest_confidence(self):
        nodes = [
            _node("a_foo", "Idea", "Foo"),
            _node("b_foo", "Idea", "Foo"),
            _node("a_bar", "Idea", "Bar"),
            _node("b_bar", "Idea", "Bar"),
        ]
        # Same logical edge from two different files with different
        # confidence scores. After merge they collapse — keep the higher.
        rels = [
            _sem("a_foo", "a_bar", "relates_to", score=0.65),
            _sem("b_foo", "b_bar", "relates_to", score=0.85),
        ]
        out_nodes, out_rels, stats = merge_entities(nodes, rels)
        sem_rels = [r for r in out_rels if r.type == "SEMANTIC_EDGE"]
        assert len(sem_rels) == 1
        assert (sem_rels[0].properties or {})["confidence_score"] == 0.85
        assert stats.edges_deduped == 1

    def test_semantic_edges_different_relations_stay_separate(self):
        nodes = [
            _node("a_foo", "Idea", "Foo"),
            _node("b_foo", "Idea", "Foo"),
            _node("a_bar", "Idea", "Bar"),
            _node("b_bar", "Idea", "Bar"),
        ]
        rels = [
            _sem("a_foo", "a_bar", "uses"),
            _sem("b_foo", "b_bar", "implies"),
        ]
        _, out_rels, _ = merge_entities(nodes, rels)
        sem_rels = [r for r in out_rels if r.type == "SEMANTIC_EDGE"]
        # Same endpoints after merge, but different relations → keep both.
        assert len(sem_rels) == 2


class TestStability:
    def test_canonical_pick_deterministic_across_runs(self):
        # Same-length labels — tie-break should be by ID order, stable.
        nodes_v1 = [
            _node("z_foo", "Idea", "Foo"),
            _node("a_foo", "Idea", "Foo"),
            _node("m_foo", "Idea", "Foo"),
        ]
        nodes_v2 = list(reversed(nodes_v1))
        out1, _, _ = merge_entities(nodes_v1, [])
        out2, _, _ = merge_entities(nodes_v2, [])
        # Same canonical chosen regardless of input order.
        assert out1[0].id == out2[0].id == "a_foo"


class TestEmptyAndDegenerate:
    def test_empty_input(self):
        out_nodes, out_rels, stats = merge_entities([], [])
        assert out_nodes == [] and out_rels == []
        assert stats == MergeStats()

    def test_single_node_no_op(self):
        nodes = [_node("a_foo", "Idea", "Foo")]
        out_nodes, _, stats = merge_entities(nodes, [])
        assert len(out_nodes) == 1
        assert stats.nodes_merged == 0
        assert stats.groups_considered == 1
