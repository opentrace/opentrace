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

"""Verify stage — mechanical numeric-claim check on compiled pages (no LLM).

A number that appears in none of a page's cited sources cannot be grounded
by construction — it is either invented or leaked from the model's priors
(benchmark proof case: a page claiming "17× faster ... according to the
README" when no source contains any such figure). Sentences carrying such
claims are stripped and logged; prevention lives in the synthesis prompts,
this is the tripwire behind them.

Only claim-shaped numerics are checked — multipliers (17×/17x/17 times,
ranges like 5-50x), percentages, and version numbers. Bare integers are NOT
checked (false-positive risk). The check is conservative: a claim is stripped
only when every cited source body was available and none contains a variant
of it; with any body missing the claim is kept and the skip logged.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from opentrace_agent.wiki.ingest.types import (
    CompiledPage,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)

# Claim-shaped numerics. Multiplier `x` must not run into a word ("0x1F",
# "x86") — hence the lookahead; `times` and `fold` count as spellings of ×.
_MULTIPLIER_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(?:[-–—]\s*(\d+(?:\.\d+)?)\s*)?(?:×|x(?!\w)|times\b|fold\b|-fold\b)",
    re.IGNORECASE,
)
_PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:%|percent\b|per cent\b)", re.IGNORECASE)
# Version-like: `v` prefix, or at least two dots — a bare decimal (2.5) is not
# claim-shaped enough to strip on.
_VERSION_RE = re.compile(r"\bv(\d+(?:\.\d+)+)\b|\b(\d+(?:\.\d+){2,})\b", re.IGNORECASE)


def _num_pattern(literal: str) -> str:
    """Regex for a numeric literal, tolerant of a redundant ``.0``.

    Guarded on the left so "17x" doesn't ground against "217x"."""
    base = literal[:-2] if literal.endswith(".0") else literal
    pat = re.escape(base)
    if "." not in base:
        pat += r"(?:\.0)?"
    return r"(?<![\d.])" + pat


def _claims(text: str) -> list[tuple[str, str]]:
    """Extract ``(display, source_pattern)`` claim pairs from *text*.

    ``display`` is the claim as written (for logs); ``source_pattern`` is a
    regex matching any spelling variant of the same claim (17× / 17x /
    17 times / 17-fold; 45% / 45 percent; v2.7.1 / 2.7.1).
    """
    out: list[tuple[str, str]] = []
    for m in _MULTIPLIER_RE.finditer(text):
        lo, hi = m.group(1), m.group(2)
        pat = _num_pattern(lo)
        if hi:
            pat += r"\s*[-–—]\s*" + _num_pattern(hi)
        pat += r"\s*(?:×|x(?!\w)|times\b|-?fold\b)"
        out.append((m.group(0).strip(), pat))
    for m in _PERCENT_RE.finditer(text):
        out.append((m.group(0).strip(), _num_pattern(m.group(1)) + r"\s*(?:%|percent\b|per cent\b)"))
    for m in _VERSION_RE.finditer(text):
        version = m.group(1) or m.group(2)
        out.append((m.group(0).strip(), r"v?" + re.escape(version) + r"\b"))
    return out


def _grounded(pattern: str, bodies: list[str]) -> bool:
    rx = re.compile(pattern, re.IGNORECASE)
    return any(rx.search(body) for body in bodies)


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def _strip_claim_from_body(body: str, claim_display: str) -> str | None:
    """Remove the sentence (or list-item/table-row line) carrying *claim*.

    Returns the new body, or None when the claim sits somewhere structural
    (a heading, or the line vanished already) and stripping would do more
    damage than the claim — the caller logs those as kept.
    """
    lines = body.split("\n")
    for i, line in enumerate(lines):
        if claim_display not in line:
            continue
        if line.lstrip().startswith("#"):
            return None  # never strip headings (H1 included)
        stripped = line.lstrip()
        if stripped.startswith(("|", "-", "*", "+")) or re.match(r"\d+\.\s", stripped):
            del lines[i]  # list item / table row: the line IS the claim's unit
            return "\n".join(lines)
        sentences = _SENTENCE_SPLIT_RE.split(line)
        kept = [s for s in sentences if claim_display not in s]
        if kept:
            lines[i] = " ".join(kept)
        else:
            del lines[i]
        return "\n".join(lines)
    return None


def strip_ungrounded_numerics(
    compiled: list[CompiledPage],
    sha_to_body: dict[str, str],
) -> Iterator[WikiPipelineEvent]:
    """Strip numeric claims no cited source contains; mutates ``markdown_body``.

    *sha_to_body* maps source sha256 → raw markdown for every body that could
    be located (this batch's normalized sources plus corpus files for
    previously-ingested citations).
    """
    for page in compiled:
        bodies = [sha_to_body[sha] for sha in page.source_shas if sha in sha_to_body]
        missing = len(page.source_shas) - len(bodies)
        stripped: list[str] = []
        skipped: list[str] = []
        seen: set[str] = set()
        # Claims are re-extracted after each strip — removing one sentence can
        # remove several claims at once.
        while True:
            claim = next(
                (
                    (d, p)
                    for d, p in _claims(page.markdown_body)
                    if d not in seen and not _grounded(p, bodies)
                ),
                None,
            )
            if claim is None:
                break
            display, _ = claim
            seen.add(display)
            if missing:
                # Can't prove the claim ungrounded without every cited body.
                skipped.append(display)
                continue
            new_body = _strip_claim_from_body(page.markdown_body, display)
            if new_body is None:
                skipped.append(display)
                continue
            page.markdown_body = new_body
            stripped.append(display)
        if stripped:
            yield WikiPipelineEvent(
                kind=WikiEventKind.STAGE_PROGRESS,
                phase=WikiPhase.EXECUTING,
                message=(
                    f"⚠ Stripped {len(stripped)} ungrounded numeric claim(s) "
                    f"from {page.slug}: {', '.join(stripped)}"
                ),
                file_name=page.slug,
                detail={"page": page.slug, "stripped": stripped},
            )
        if skipped:
            reason = f"{missing} cited source(s) unavailable" if missing else "claim sits in a heading"
            yield WikiPipelineEvent(
                kind=WikiEventKind.STAGE_PROGRESS,
                phase=WikiPhase.EXECUTING,
                message=(
                    f"⚠ Kept {len(skipped)} unverifiable numeric claim(s) "
                    f"on {page.slug} ({reason}): {', '.join(skipped)}"
                ),
                file_name=page.slug,
                detail={"page": page.slug, "kept": skipped, "missing_sources": missing},
            )
