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

"""Tests for the Resolve stage — clustering, the (topic, subject) merge, the
min-sources floor, and the create/extend diff against the vault."""

from __future__ import annotations

from opentrace_agent.wiki.ingest.resolve import (
    concepts_to_plan,
    resolve,
)
from opentrace_agent.wiki.ingest.types import ConceptMention, ResolvedConcept
from opentrace_agent.wiki.vault import PageMeta, VaultMetadata


def _m(topic: str, subject: str, sha: str, gloss: str = "g") -> ConceptMention:
    return ConceptMention(topic=topic, subject=subject, gloss=gloss, source_sha=sha)


def _subjects(*groups: tuple[str, list[str]]) -> tuple[str, dict]:
    """Script a Level-1 canonicalize_subjects response: (canonical, [sids])."""
    return ("canonicalize_subjects", {"groups": [{"canonical": c, "member_ids": ids} for c, ids in groups]})


def _concepts(*items: dict) -> tuple[str, dict]:
    """Script a Level-2 propose_concepts response (each item names member t-ids)."""
    return ("propose_concepts", {"concepts": list(items)})


def _tools(llm) -> list[str]:
    return [name for name, _ in llm.calls]


class TestResolve:
    def test_single_subject_skips_the_subject_pass(self, fake_llm):
        # One distinct subject → Level 1 is a no-op and makes NO LLM call; only
        # the topic-clustering call runs. Sources come from pair membership.
        mentions = [_m("validation", "pydantic", "a"), _m("validation", "pydantic", "b")]
        llm = fake_llm([_concepts({"title": "Validation", "subject": "pydantic", "member_ids": ["t1"]})])
        out = resolve(mentions, llm)
        assert _tools(llm) == ["propose_concepts"]  # no subject pass
        assert len(out) == 1
        assert out[0].title == "Validation"
        assert set(out[0].source_shas) == {"a", "b"}

    def test_merges_synonymous_topics_within_subject(self, fake_llm):
        # Different topic LABELS, one subject → the model merges them into one
        # concept and resolve unions every member pair's sources.
        mentions = [
            _m("validation", "pydantic", "a"),
            _m("data validation", "pydantic", "b"),
            _m("type validation", "pydantic", "c"),
        ]
        llm = fake_llm(
            [_concepts({"title": "Validation", "subject": "pydantic", "member_ids": ["t1", "t2", "t3"]})]
        )
        out = resolve(mentions, llm)
        assert len(out) == 1
        assert set(out[0].source_shas) == {"a", "b", "c"}

    def test_canonicalizes_subjects_then_clusters(self, fake_llm):
        # Level 1 folds a sub-component (pydantic_core) into its parent (Pydantic);
        # the two mentions then collapse to one (subject, topic) pair → one page.
        mentions = [_m("serialization", "Pydantic", "a"), _m("serialization", "pydantic_core", "b")]
        out = resolve(
            mentions,
            fake_llm(
                [
                    _subjects(("Pydantic", ["s1", "s2"])),
                    _concepts({"title": "Serialization", "subject": "Pydantic", "member_ids": ["t1"]}),
                ]
            ),
        )
        assert len(out) == 1
        assert out[0].subject == "Pydantic"
        assert set(out[0].source_shas) == {"a", "b"}

    def test_keeps_distinct_subjects_separate(self, fake_llm):
        # Level 1 leaves Acme and Globex as distinct entities → two pages, even
        # though they share the topic "security".
        mentions = [_m("security", "Acme", "a"), _m("security", "Globex", "b")]
        out = resolve(
            mentions,
            fake_llm(
                [
                    _subjects(("Acme", ["s1"]), ("Globex", ["s2"])),
                    _concepts(
                        {"title": "Security of Acme", "subject": "Acme", "member_ids": ["t1"]},
                        {"title": "Security of Globex", "subject": "Globex", "member_ids": ["t2"]},
                    ),
                ]
            ),
        )
        assert {c.title for c in out} == {"Security of Acme", "Security of Globex"}

    def test_groups_subtopics_into_one_page_with_section_outline(self, fake_llm):
        # Finer topics are absorbed into one page as SECTIONS (not dropped, not
        # separate pages); source_shas unions across all members.
        mentions = [
            _m("field aliasing", "pydantic", "a"),
            _m("field exclusion", "pydantic", "b"),
            _m("computed fields", "pydantic", "c"),
        ]
        llm = fake_llm(
            [
                _concepts(
                    {
                        "title": "Fields",
                        "subject": "pydantic",
                        "member_ids": ["t1", "t2", "t3"],
                        "sections": ["Field aliasing", "Field exclusion", "Computed fields"],
                    }
                )
            ]
        )
        out = resolve(mentions, llm)
        assert len(out) == 1
        assert out[0].title == "Fields"
        assert out[0].sections == ["Field aliasing", "Field exclusion", "Computed fields"]
        assert set(out[0].source_shas) == {"a", "b", "c"}

    def test_large_topic_set_uses_two_step_theme_discovery(self, fake_llm):
        # > THEME_THRESHOLD distinct topics (one subject) → discover broad pages,
        # then file every topic under one. Two calls: propose_pages, propose_concepts.
        mentions = [_m(f"topic{i}", "pydantic", f"sha{i}") for i in range(14)]
        themes = (
            "propose_pages",
            {"pages": [{"title": "Fields", "subject": "pydantic"}, {"title": "Validation", "subject": "pydantic"}]},
        )
        assign = (
            "propose_concepts",
            {
                "concepts": [
                    {"title": "Fields", "subject": "pydantic", "member_ids": [f"t{i}" for i in range(1, 8)]},
                    {"title": "Validation", "subject": "pydantic", "member_ids": [f"t{i}" for i in range(8, 15)]},
                ]
            },
        )
        llm = fake_llm([themes, assign])
        out = resolve(mentions, llm)
        assert _tools(llm) == ["propose_pages", "propose_concepts"]  # two-step engaged
        assert {c.title for c in out} == {"Fields", "Validation"}
        allshas = set().union(*[set(c.source_shas) for c in out])
        assert len(allshas) == 14  # every topic filed, nothing dropped

    def test_empty_mentions_skips_llm(self, fake_llm):
        llm = fake_llm([])
        assert resolve([], llm) == []
        assert llm.calls == []

    def test_ignores_unknown_member_id(self, fake_llm):
        # A member id with no matching pair is dropped; sources stay correct.
        mentions = [_m("validation", "pydantic", "a")]
        llm = fake_llm([_concepts({"title": "Validation", "subject": "pydantic", "member_ids": ["t1", "t99"]})])
        out = resolve(mentions, llm)
        assert len(out) == 1
        assert set(out[0].source_shas) == {"a"}

    def test_unplaced_pair_becomes_its_own_concept(self, fake_llm):
        # The model clusters t1 but forgets t2 → resolve adds the orphan back as
        # its own concept so no source is silently dropped.
        mentions = [
            _m("validation", "pydantic", "a"),
            _m("validation", "pydantic", "b"),
            _m("caching", "pydantic", "c"),
            _m("caching", "pydantic", "d"),
        ]
        llm = fake_llm([_concepts({"title": "Validation", "subject": "pydantic", "member_ids": ["t1"]})])
        out = resolve(mentions, llm)
        assert len(out) == 2
        orphan = next(c for c in out if c.topic == "caching")
        assert set(orphan.source_shas) == {"c", "d"}

    def test_clustering_failure_falls_back_to_identity(self):
        # If the topic-cluster call errors, every pair survives as its own
        # concept rather than crashing or dropping content.
        class _Boom:
            def call_tool(self, **_kw):
                raise RuntimeError("llm down")

        mentions = [_m("validation", "pydantic", "a"), _m("serialization", "pydantic", "b")]
        out = resolve(mentions, _Boom())
        assert {c.topic for c in out} == {"validation", "serialization"}
        assert len(out) == 2


class TestConceptsToPlan:
    def _resolved(self, title, shas, topic="t", subject="s"):
        return ResolvedConcept(title=title, topic=topic, subject=subject, source_shas=shas)

    def test_new_concept_below_floor_is_skipped(self):
        meta = VaultMetadata.empty("v")
        plan = concepts_to_plan([self._resolved("Solo", ["a"])], meta)  # default floor = 2
        assert plan.creates == [] and plan.extends == []

    def test_new_concept_at_floor_is_created(self):
        meta = VaultMetadata.empty("v")
        plan = concepts_to_plan([self._resolved("Pair", ["a", "b"])], meta)
        assert len(plan.creates) == 1
        assert plan.creates[0].title == "Pair"
        assert plan.creates[0].source_shas == ["a", "b"]

    def test_existing_concept_becomes_extend_regardless_of_floor(self):
        meta = VaultMetadata.empty("v")
        meta.pages["concept/validation"] = PageMeta(
            slug="concept/validation", title="Validation", one_line_summary="x", kind="concept"
        )
        # Single new source, but the concept already has a page → extend, no floor.
        plan = concepts_to_plan([self._resolved("validation", ["c"])], meta)
        assert plan.creates == []
        assert len(plan.extends) == 1
        assert plan.extends[0].page_slug == "concept/validation"
        assert plan.extends[0].source_shas == ["c"]

    def test_floor_override(self, monkeypatch):
        monkeypatch.setenv("OT_WIKI_CONCEPT_MIN_SOURCES", "1")
        meta = VaultMetadata.empty("v")
        plan = concepts_to_plan([self._resolved("Solo", ["a"])], meta)
        assert len(plan.creates) == 1
