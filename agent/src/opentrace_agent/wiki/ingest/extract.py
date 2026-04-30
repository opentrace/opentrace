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

"""Deterministic salience extraction from raw markdown.

Used by the Plan stage in two-tier mode as a cheap belt-and-braces against
LLM summarizer drift. The Plan prompt receives the source-summary body
(clean structured content) plus the output of this extractor (long-tail
entities the summarizer may have compressed away).

Pure function, no LLM. Runs in ~milliseconds on document-sized inputs.
"""

from __future__ import annotations

import re

# Headings at any level: capture the heading text only.
_HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$", re.MULTILINE)

# All-caps acronyms with optional digit/hyphen suffixes.
# Matches: HACCP, CCP-1, DC-7, SOP-CC-2026, RFP, CEO, T-class
# Requires at least 2 uppercase letters so single capitals (sentence
# starts) don't pollute the list.
_ACRONYM_RE = re.compile(r"\b[A-Z]{2,}(?:[-/][A-Za-z0-9]+)*\b")

# Multi-word capitalised phrases (≥2 words).
# Catches: Cold Chain, Midwest Beef Co, Priya Rao, Distribution Center
_PROPER_NOUN_RE = re.compile(r"\b[A-Z][a-z]+(?:[-’'][A-Za-z]+)?(?:\s+[A-Z][a-z]+(?:[-’'][A-Za-z]+)?){1,4}\b")

# Bold spans: **foo** or __foo__. The lookarounds prevent matching
# ** inside *** sequences. Captures the inner text.
_BOLD_RE = re.compile(r"\*\*([^*\n]+?)\*\*|__([^_\n]+?)__")

# Italic spans: *foo* or _foo_. Skip when adjacent to another marker
# (** or __) to avoid double-matching bold spans as italics.
_ITALIC_RE = re.compile(r"(?<![*_])\*([^*\n]+?)\*(?!\*)|(?<![*_])_([^_\n]+?)_(?!_)")

# Numbers with common units. Conservative — focused on units that show
# up frequently in operational/technical documents.
_NUMBER_UNIT_RE = re.compile(
    # Lead with either a comma-grouped number ("412,000") or a plain run of
    # digits ("1840"); optional decimal tail; optional minus sign.
    r"-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*"
    r"(?:°C|°F|°|min|minutes?|hours?|hrs?|sec|seconds?|"
    r"kg|lbs?|tons?|tonnes?|"
    r"sq ?ft|ft2|m2|mi|km|miles?|kilometres?|kilometers?|"
    r"%|pct|cases?|pallets?|trailers?)\b",
    re.IGNORECASE,
)


def extract_salient_terms(markdown: str) -> list[str]:
    """Pull deterministic salience signals from raw markdown.

    Returns a deduplicated, alphabetically-sorted list of terms drawn from
    headings, acronyms, multi-word proper nouns, bold and italic spans,
    and numbers paired with common units.

    No per-source cap — relies on set-based dedup and the existing
    Plan-level token-budget guard for runaway inputs. Sorting is
    alphabetical so prompt inputs are stable across runs (helps prompt
    caching and debugging diffs).
    """
    out: set[str] = set()

    for m in _HEADING_RE.finditer(markdown):
        out.add(m.group(1).strip())

    for m in _ACRONYM_RE.finditer(markdown):
        out.add(m.group(0))

    for m in _PROPER_NOUN_RE.finditer(markdown):
        out.add(m.group(0))

    for m in _BOLD_RE.finditer(markdown):
        text = (m.group(1) or m.group(2) or "").strip()
        if text:
            out.add(text)

    for m in _ITALIC_RE.finditer(markdown):
        text = (m.group(1) or m.group(2) or "").strip()
        if text:
            out.add(text)

    for m in _NUMBER_UNIT_RE.finditer(markdown):
        # Normalise whitespace so "10 min" and "10  min" dedup.
        out.add(re.sub(r"\s+", " ", m.group(0)).strip())

    return sorted(out)
