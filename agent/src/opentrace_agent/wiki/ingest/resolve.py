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

"""Resolve stage — cluster per-document concept mentions into concept pages.

Two passes, each over the small set of distinct *labels* (not the bulk
mentions), so both fit a single LLM call with a corpus-wide view:

1. **Subjects** (``_canonicalize_subjects``) — the only stage that sees every
   subject at once, so it's where "is this one system or many?" is decided.
   It folds aliases, case variants, and sub-components of a system into one
   canonical subject, while keeping genuinely distinct entities apart. That
   judgement is what makes mono- vs multi-subject behaviour *emerge from the
   data* rather than from a configuration flag.
2. **Topics within a subject** (``_cluster_topics``) — with subjects canonical,
   the distinct ``(subject, topic)`` pairs (each carrying a few sample glosses)
   are clustered into concepts. Synonymous topics ("validation" / "data
   validation", confirmed by their glosses) merge; a topic shared across two
   subjects stays two concepts. Each concept's ``source_shas`` is the union of
   every document that mentioned a member pair — derived here, never echoed by
   the model.

Both passes degrade to identity (no merging) on any LLM failure, so resolve
never crashes or silently drops mentions.
"""

from __future__ import annotations

import logging
import math
import os
import re
from dataclasses import replace
from typing import Any

from opentrace_agent.wiki.ingest.types import (
    PAGE_KIND_CONCEPT,
    ConceptMention,
    NormalizedSource,
    Plan,
    PlanCreate,
    PlanExtend,
    ResolvedConcept,
)
from opentrace_agent.wiki.llm import WikiLLM
from opentrace_agent.wiki.vault import VaultMetadata

logger = logging.getLogger(__name__)

# A scale guard, not a tuning knob: a corpus's distinct-subject and
# distinct-(subject, topic) counts sit far below this. Above it, the LLM pass is
# skipped and we fall back to identity rather than send a giant prompt.
MAX_CANON_LABELS = 1500

# Above this many distinct (subject, topic) pairs, a single open-ended "group
# these" call satisfices toward fine granularity, so Level 2 switches to a
# two-step approach (discover the broad pages, then file every topic under one).
# Below it, the topic set is small enough that one call groups it fine.
THEME_THRESHOLD = 12

_SAMPLE_TOPICS_PER_SUBJECT = 8
_SAMPLE_GLOSSES_PER_PAIR = 3

SUBJECT_CANON_SCHEMA = {
    "description": "Group the supplied subject names into canonical subjects.",
    "input_schema": {
        "type": "object",
        "properties": {
            "groups": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "canonical": {"type": "string", "description": "Canonical subject name for this group."},
                        "member_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Ids (s1, s2, …) of every subject that is the SAME entity as the canonical.",
                        },
                        "rationale": {"type": "string"},
                    },
                    "required": ["canonical", "member_ids"],
                },
            }
        },
        "required": ["groups"],
    },
}

SUBJECT_CANON_SYSTEM = """You are consolidating the list of SUBJECTS extracted from a document corpus.

A subject is the real-world entity that concepts are a property OF — a product,
library, system, vendor, person, or place. Each is shown with a short id, how
many times it was mentioned, and a few sample topics it appears with.

Group subjects that refer to the SAME entity OR are part of one project. Merge:
- case/spelling variants and obvious typos ("Pydantic" / "pydantic");
- abbreviations, acronyms, and aliases of one entity;
- companion packages and sub-components of one project — fold a project's
  satellite packages into the main project (e.g. "pydantic", "pydantic-core",
  "pydantic-settings", "pydantic-extra-types" → "pydantic"). A shared name root
  or an obvious "core/settings/extras of X" relationship is the signal.

Keep as SEPARATE groups genuinely distinct entities — different products,
vendors, tools, people, or places — EVEN IF they share topics. A competitor or
unrelated third-party tool is NOT folded in. When unsure whether two subjects
belong to the same project, keep them separate: a corpus of peers must not
collapse into one.

Every supplied id must appear in exactly one group (a singleton is fine).
Return your grouping via the canonicalize_subjects tool.
"""

TOPIC_CLUSTER_SCHEMA = {
    "description": "Group the supplied (subject, topic) pairs into concept pages with section outlines.",
    "input_schema": {
        "type": "object",
        "properties": {
            "concepts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "Canonical PAGE title; subject-qualify a topic shared across subjects.",
                        },
                        "subject": {"type": "string"},
                        "topic": {"type": "string"},
                        "member_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Ids (t1, t2, …) of EVERY pair this page covers — core plus sub-topics.",
                        },
                        "sections": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "Outline of sub-topic section headings this page absorbs (the finer topics "
                                "that become sections rather than their own pages). Empty for an atomic concept."
                            ),
                        },
                        "rationale": {"type": "string"},
                    },
                    "required": ["member_ids"],
                },
            }
        },
        "required": ["concepts"],
    },
}

TOPIC_CLUSTER_SYSTEM = """You are organising concept mentions into the set of pages a competent wiki author would write.

Each line is a (subject, topic) pair with a short id and a few sample glosses.
The subjects are already canonical. Each page you propose becomes ONE synthesis
call, so the goal is the right GRANULARITY — not the fewest pages, not the most.

Organise the pairs into pages. The rule is page-vs-section, NOT keep-vs-drop —
every pair must appear somewhere, but a finer topic that a reader would expect
to find as a SECTION of a broader page belongs there, not on its own page:
- A broad concept and its sub-aspects are ONE page. Put the broad topic's id and
  every sub-aspect's id in that page's `member_ids`, and list the sub-aspects in
  `sections` (e.g. page "Fields" with sections "Aliases", "Exclusion",
  "Computed fields", "Private attributes" — one page, not five).
- MERGE pairs that mean the same thing even when the label differs ("validation"
  / "data validation"); these are the same section, not separate ones.
- Give a topic its OWN page only when it's substantial and stands alone
  (e.g. "Strict mode", "Unions"), not when it's really a facet of a broader one.
- Only group pairs that share the SAME subject. NEVER group across subjects;
  subject-qualify a title when a topic is shared across subjects.

Every supplied id must appear in exactly one page's `member_ids`. Give each page
a canonical title and a `sections` outline (empty if the page is atomic). Return
via the propose_concepts tool.
"""

THEME_DISCOVERY_SCHEMA = {
    "description": "Propose the top-level concept pages (the wiki's page structure) for these topics.",
    "input_schema": {
        "type": "object",
        "properties": {
            "pages": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "A broad, top-level page title."},
                        "subject": {"type": "string", "description": "The subject this page belongs to."},
                    },
                    "required": ["title"],
                },
            }
        },
        "required": ["pages"],
    },
}

THEME_DISCOVERY_SYSTEM = """You are designing the top-level page structure of a wiki built from concept topics.

You're shown, per subject, the topics found across the corpus. Propose the set of
top-level CONCEPT PAGES a competent wiki author would create — broad, durable pages,
each covering a coherent area with room for sub-sections.

GROUP related topics under ONE page: e.g. "field definition", "field aliases",
"field exclusion", "computed fields" all belong to a single "Fields" page;
"validation", "type validation", "strict mode" to a "Validation" page.

Aim for the natural set, NOT one page per topic — a large library is typically
15-30 pages. Each page belongs to ONE subject; never span subjects. Return the
page titles via the propose_pages tool.
"""

ASSIGN_SYSTEM = """You are filing concept topics into a FIXED set of wiki pages.

You're given the page structure (titles + subjects) and a list of (subject, topic)
pairs with glosses. Assign EVERY pair to exactly one page that matches its subject:
- put each pair's id in that page's `member_ids`;
- name the sub-topics it covers in `sections`; pairs that mean the same thing share
  ONE section heading — do not list near-duplicates as separate sections;
- prefer the given pages; introduce a new page only if a pair genuinely fits none.

Never assign a pair to a page of a different subject. Every supplied id must appear
in exactly one page. Return the filled pages via the propose_concepts tool.
"""


def _concept_min_sources() -> int:
    """Minimum distinct source documents for a NEW concept page
    (``OT_WIKI_CONCEPT_MIN_SOURCES``, default 2). A concept page is multi-source
    synthesis — single-source content stays reachable through its Source node
    (label + corpus body via load_source), so paging it would duplicate the
    raw doc. Extends of existing concept pages are not subject to this floor."""
    raw = os.environ.get("OT_WIKI_CONCEPT_MIN_SOURCES", "").strip()
    try:
        return max(1, int(raw)) if raw else 2
    except ValueError:
        return 2


def _norm(s: str) -> str:
    return " ".join((s or "").lower().split())


def _derive_title(topic: str, subject: str) -> str:
    """Fallback title for a concept the model didn't title — capitalise the
    topic, subject-qualifying it when the subject isn't already implied."""
    t = (topic or "").strip()
    s = (subject or "").strip()
    base = (t[:1].upper() + t[1:]) if t else s
    if not base:
        return "Untitled"
    if s and _norm(s) not in _norm(base):
        return f"{base} ({s})"
    return base


def _canonicalize_subjects(mentions: list[ConceptMention], llm: WikiLLM) -> dict[str, str]:
    """Level 1: map each distinct subject (by normalised form) to a canonical
    subject via one corpus-wide LLM call. Returns ``{}`` (identity) when there's
    nothing to merge, the label set is implausibly large, or the call fails."""
    order: list[str] = []
    info: dict[str, dict[str, Any]] = {}
    for m in mentions:
        n = _norm(m.subject)
        if not n:
            continue
        rec = info.get(n)
        if rec is None:
            rec = {"display": m.subject.strip(), "count": 0, "topics": []}
            info[n] = rec
            order.append(n)
        rec["count"] += 1
        t = (m.topic or "").strip()
        if t and t not in rec["topics"] and len(rec["topics"]) < _SAMPLE_TOPICS_PER_SUBJECT:
            rec["topics"].append(t)

    if len(order) <= 1 or len(order) > MAX_CANON_LABELS:
        return {}

    sid_to_norm: dict[str, str] = {}
    lines = ["Subjects extracted across the corpus (one per line):"]
    for i, n in enumerate(order, 1):
        sid = f"s{i}"
        sid_to_norm[sid] = n
        rec = info[n]
        lines.append(f'- {sid} | "{rec["display"]}" | {rec["count"]} mentions | topics: {", ".join(rec["topics"])}')
    user = "\n".join(lines) + "\n\nCall canonicalize_subjects with your grouping."

    try:
        result = llm.call_tool(
            system=SUBJECT_CANON_SYSTEM,
            user=user,
            tool_name="canonicalize_subjects",
            tool_schema=SUBJECT_CANON_SCHEMA,
            max_tokens=8000,
        )
    except Exception:
        logger.exception("resolve: subject canonicalization failed — falling back to identity")
        return {}

    norm_to_canon: dict[str, str] = {}
    for g in result.get("groups") or []:
        if not isinstance(g, dict):
            continue
        canon = (g.get("canonical") or "").strip()
        if not canon:
            continue
        for ref in g.get("member_ids") or []:
            n = sid_to_norm.get(str(ref).strip())
            if n is not None and n not in norm_to_canon:
                norm_to_canon[n] = canon
    return norm_to_canon


def _open_cluster(pairs_block: str, llm: WikiLLM) -> list[Any] | None:
    """Single-call clustering for a small topic set — group freely into pages."""
    try:
        result = llm.call_tool(
            system=TOPIC_CLUSTER_SYSTEM,
            user=pairs_block + "\n\nCall propose_concepts with your clustering.",
            tool_name="propose_concepts",
            tool_schema=TOPIC_CLUSTER_SCHEMA,
            max_tokens=16000,
        )
        return result.get("concepts") or []
    except Exception:
        logger.exception("resolve: topic clustering failed — one concept per (subject, topic)")
        return None


def _discover_themes(order: list[tuple[str, str]], pairs: dict, llm: WikiLLM) -> list[dict]:
    """Step 2a: from the topics (grouped by subject), propose the broad top-level
    pages — committing to a small page set up front is what forces grouping at
    scale (an open 'cluster these' call over hundreds of pairs satisfices)."""
    by_subject: dict[str, list[str]] = {}
    for key in order:
        rec = pairs[key]
        by_subject.setdefault(rec["subject"], [])
        if rec["topic"] not in by_subject[rec["subject"]]:
            by_subject[rec["subject"]].append(rec["topic"])
    lines = ["Topics by subject:"]
    for subject, topics in by_subject.items():
        lines.append(f'subject "{subject}":')
        lines.append("  " + ", ".join(topics))
    try:
        result = llm.call_tool(
            system=THEME_DISCOVERY_SYSTEM,
            user="\n".join(lines) + "\n\nCall propose_pages.",
            tool_name="propose_pages",
            tool_schema=THEME_DISCOVERY_SCHEMA,
            max_tokens=4000,
        )
    except Exception:
        logger.exception("resolve: theme discovery failed — falling back to open clustering")
        return []
    pages = []
    for p in result.get("pages") or []:
        if isinstance(p, dict) and (p.get("title") or "").strip():
            pages.append({"title": p["title"].strip(), "subject": (p.get("subject") or "").strip()})
    return pages


def _assign_to_themes(themes: list[dict], pairs_block: str, llm: WikiLLM) -> list[Any] | None:
    """Step 2b: file every (subject, topic) pair under one of the discovered
    pages, as a section — the fixed page set is what curbs over-splitting."""
    page_list = "\n".join(f'- "{t["title"]}" (subject: {t["subject"]})' for t in themes)
    try:
        result = llm.call_tool(
            system=ASSIGN_SYSTEM,
            user=f"Pages to file every topic under:\n{page_list}\n\n{pairs_block}\n\nCall propose_concepts.",
            tool_name="propose_concepts",
            tool_schema=TOPIC_CLUSTER_SCHEMA,
            max_tokens=16000,
        )
        return result.get("concepts") or []
    except Exception:
        logger.exception("resolve: theme assignment failed — falling back to open clustering")
        return None


def _concepts_from_groups(
    groups: list[Any] | None, tid_to_key: dict[str, tuple[str, str]], pairs: dict
) -> tuple[list[ResolvedConcept], set[tuple[str, str]]]:
    """Turn the model's page groups into ResolvedConcepts. Sources come from pair
    membership (never echoed by the model), so a garbled id can't drop a source."""
    resolved: list[ResolvedConcept] = []
    assigned: set[tuple[str, str]] = set()
    for c in groups or []:
        if not isinstance(c, dict):
            continue
        member_keys: list[tuple[str, str]] = []
        shas: list[str] = []
        for ref in c.get("member_ids") or []:
            key = tid_to_key.get(str(ref).strip())
            if key is None or key in assigned:
                continue
            assigned.add(key)
            member_keys.append(key)
            for s in pairs[key]["shas"]:
                if s not in shas:
                    shas.append(s)
        if not member_keys:
            continue
        first = pairs[member_keys[0]]
        subject = (c.get("subject") or "").strip() or first["subject"]
        topic = (c.get("topic") or "").strip() or first["topic"]
        title = (c.get("title") or "").strip() or _derive_title(topic, subject)
        sections = [str(s).strip() for s in (c.get("sections") or []) if str(s).strip()]
        resolved.append(
            ResolvedConcept(
                title=title,
                topic=topic,
                subject=subject,
                source_shas=shas,
                rationale=(c.get("rationale") or ""),
                sections=sections,
            )
        )
    return resolved, assigned


def _cluster_topics(mentions: list[ConceptMention], llm: WikiLLM) -> list[ResolvedConcept]:
    """Level 2: organise the distinct ``(subject, topic)`` pairs into concept
    pages. Small topic sets group in one open call; large sets use the two-step
    discover-pages-then-file approach so they don't fragment into a page-per-topic.
    Pairs the model fails to place — or every pair, on failure — survive as their
    own page so nothing is dropped.
    """
    order: list[tuple[str, str]] = []
    pairs: dict[tuple[str, str], dict[str, Any]] = {}
    for m in mentions:
        sk, tk = _norm(m.subject), _norm(m.topic)
        if not tk:
            continue
        key = (sk, tk)
        rec = pairs.get(key)
        if rec is None:
            rec = {"subject": m.subject.strip(), "topic": m.topic.strip(), "shas": [], "glosses": []}
            pairs[key] = rec
            order.append(key)
        if m.source_sha not in rec["shas"]:
            rec["shas"].append(m.source_sha)
        g = (m.gloss or "").strip()
        if g and g not in rec["glosses"] and len(rec["glosses"]) < _SAMPLE_GLOSSES_PER_PAIR:
            rec["glosses"].append(g)

    if not order:
        return []

    tid_to_key: dict[str, tuple[str, str]] = {}
    lines = ["(subject, topic) pairs (one per line):"]
    for i, key in enumerate(order, 1):
        tid = f"t{i}"
        tid_to_key[tid] = key
        rec = pairs[key]
        gl = " ; ".join(rec["glosses"])
        lines.append(f'- {tid} | subject="{rec["subject"]}" | topic="{rec["topic"]}" | glosses: {gl}')
    pairs_block = "\n".join(lines)

    groups: list[Any] | None
    if len(order) > MAX_CANON_LABELS:
        groups = None  # too large to reason over → atomic fallback (one page per pair)
    elif len(order) > THEME_THRESHOLD:
        themes = _discover_themes(order, pairs, llm)
        groups = _assign_to_themes(themes, pairs_block, llm) if themes else None
        if groups is None:  # discovery or assignment failed → degrade to one open call
            groups = _open_cluster(pairs_block, llm)
    else:
        groups = _open_cluster(pairs_block, llm)

    resolved, assigned = _concepts_from_groups(groups, tid_to_key, pairs)

    # Orphans — any pair the model didn't place (or all pairs, on the fallback
    # path) become their own page so no content is silently dropped.
    for key in order:
        if key in assigned:
            continue
        rec = pairs[key]
        resolved.append(
            ResolvedConcept(
                title=_derive_title(rec["topic"], rec["subject"]),
                topic=rec["topic"],
                subject=rec["subject"],
                source_shas=list(rec["shas"]),
                rationale="",
            )
        )
    return resolved


def resolve(mentions: list[ConceptMention], llm: WikiLLM) -> list[ResolvedConcept]:
    """Cluster concept mentions into concept specs via two label-level passes:
    canonicalize subjects globally, then cluster topics within each subject."""
    if not mentions:
        return []
    subj_map = _canonicalize_subjects(mentions, llm)
    if subj_map:
        mentions = [replace(m, subject=subj_map.get(_norm(m.subject), m.subject)) for m in mentions]
    return _cluster_topics(mentions, llm)


def concepts_to_plan(resolved: list[ResolvedConcept], meta: VaultMetadata) -> Plan:
    """Turn resolved concepts into a create/extend plan against the vault.

    A concept whose title matches an existing **concept** page becomes an
    EXTEND (its new sources are added, no source floor). A new concept is
    CREATEd only when it draws on at least ``OT_WIKI_CONCEPT_MIN_SOURCES``
    documents — a single-source concept stays reachable through its Source
    node (label + raw corpus body), so paging it would just duplicate the doc.
    """
    min_sources = _concept_min_sources()
    existing_concept_slug_by_title = {
        _norm(p.title): p.slug for p in meta.pages.values() if p.kind == PAGE_KIND_CONCEPT
    }

    creates: list[PlanCreate] = []
    extends: list[PlanExtend] = []
    for c in resolved:
        if not c.source_shas:
            continue
        slug = existing_concept_slug_by_title.get(_norm(c.title))
        if slug is not None:
            extends.append(
                PlanExtend(
                    page_slug=slug,
                    source_shas=list(c.source_shas),
                    rationale=c.rationale,
                    sections=list(c.sections),
                )
            )
        elif len(c.source_shas) >= min_sources:
            creates.append(
                PlanCreate(
                    title=c.title,
                    source_shas=list(c.source_shas),
                    rationale=c.rationale,
                    sections=list(c.sections),
                )
            )
        else:
            logger.info(
                "resolve: skipping new concept %r — only %d source(s), below floor of %d",
                c.title,
                len(c.source_shas),
                min_sources,
            )
    return Plan(creates=creates, extends=extends)


# --- Plan-time source augmentation (mechanical, no LLM) ----------------------
#
# The clusterer assigns each doc's mentions to pages by (topic, subject) label.
# When a doc inventories related content under a *different* label, the page it
# contradicts/completes never sees it (benchmark proof case: the one doc with
# the correct behaviour was filed under an adjacent concept, so every page kept
# the superseded rule). This pass widens each synthesis call's reading list by
# plain term matching so relevant-but-misfiled docs can't be structurally
# invisible. Clustering itself is untouched.

AUGMENT_CAP = 3  # max sources added per page
AUGMENT_MIN_SCORE = 0.35  # min fraction of the page's term weight a doc must match

_AUGMENT_STOPWORDS = frozenset(
    "the a an and or of to in for on with by from as at is are was were be been "
    "this that these those it its how what when why which who all any not no "
    "does do did can could should would may might will into over under between "
    "via per each both more most other same new use used using".split()
)


def _augment_cap() -> int:
    """``OT_WIKI_AUGMENT_CAP`` overrides AUGMENT_CAP; 0 disables the pass."""
    raw = os.environ.get("OT_WIKI_AUGMENT_CAP", "").strip()
    try:
        return max(0, int(raw)) if raw else AUGMENT_CAP
    except ValueError:
        return AUGMENT_CAP


def _terms(*texts: str) -> set[str]:
    """Distinctive lowercase tokens (identifiers kept whole via ``_``)."""
    toks: set[str] = set()
    for text in texts:
        toks.update(re.findall(r"[a-z0-9_]{3,}", text.lower()))
    return toks - _AUGMENT_STOPWORDS


def augment_plan_sources(
    plan: Plan,
    normalized: list[NormalizedSource],
) -> list[tuple[str, list[str]]]:
    """Widen each planned page's cited sources by IDF-weighted term matching.

    For every create/extend: terms from the page title + sections are scored
    against each not-yet-cited doc — score = matched term weight / total term
    weight — and docs above ``AUGMENT_MIN_SCORE`` (top ``AUGMENT_CAP``) are
    appended to ``source_shas`` (honest CITES provenance) and recorded in
    ``augmented_shas`` (marked as supplementary in the synthesis prompt).

    Mutates *plan* in place; returns ``(page label, [added doc names])`` per
    augmented page for progress reporting.
    """
    cap = _augment_cap()
    if cap == 0 or not normalized:
        return []

    doc_tokens = {n.sha256: _terms(n.markdown) for n in normalized}
    name_by_sha = {n.sha256: n.original_name for n in normalized}
    n_docs = len(doc_tokens)

    def idf(term: str) -> float:
        df = sum(1 for toks in doc_tokens.values() if term in toks)
        return math.log(1 + n_docs / df) if df else 0.0

    report: list[tuple[str, list[str]]] = []
    items: list[tuple[str, PlanCreate | PlanExtend]] = [(c.title, c) for c in plan.creates] + [
        (x.page_slug, x) for x in plan.extends
    ]
    for label, item in items:
        page_terms = _terms(label.replace("-", " ").replace("/", " "), *item.sections)
        weights = {t: idf(t) for t in page_terms}
        weights = {t: w for t, w in weights.items() if w > 0}  # drop terms in no doc
        total = sum(weights.values())
        if not total:
            continue
        cited = set(item.source_shas)
        scored = sorted(
            (
                (sum(w for t, w in weights.items() if t in toks) / total, sha)
                for sha, toks in doc_tokens.items()
                if sha not in cited
            ),
            key=lambda s: (-s[0], name_by_sha[s[1]]),
        )
        added = [sha for score, sha in scored[:cap] if score >= AUGMENT_MIN_SCORE]
        if not added:
            continue
        item.source_shas.extend(added)
        item.augmented_shas.extend(added)
        report.append((label, [name_by_sha[sha] for sha in added]))
    return report
