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

"""Page title → filesystem slug, with collision suffixes and tombstone awareness."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

MAX_SLUG_LEN = 80
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def base_slug(title: str) -> str:
    """Return the base (suffix-free) slug for *title*.

    Lowercased, ASCII-folded, non-alphanumeric runs collapsed to a single dash,
    truncated to MAX_SLUG_LEN. Empty input yields ``"untitled"``.
    """
    if not title:
        return "untitled"
    folded = unicodedata.normalize("NFKD", title)
    folded = folded.encode("ascii", "ignore").decode("ascii")
    folded = folded.lower()
    folded = _NON_ALNUM.sub("-", folded).strip("-")
    if not folded:
        return "untitled"
    return folded[:MAX_SLUG_LEN].rstrip("-") or "untitled"


def unique_slug(
    title: str,
    *,
    existing: Iterable[str],
    tombstones: Iterable[str] = (),
) -> str:
    """Pick a fresh slug for *title* that doesn't collide with existing or tombstoned slugs.

    Suffixes ``-2``, ``-3``, ... are appended on collision. Tombstones reserve
    slugs of pages that previously existed so old ``[[wiki-links]]`` don't
    silently retarget.
    """
    used = set(existing) | set(tombstones)
    base = base_slug(title)
    if base not in used:
        return base
    n = 2
    while True:
        candidate = f"{base}-{n}"
        if candidate not in used:
            return candidate
        n += 1


def title_to_link_slug(title: str) -> str:
    """The slug that ``[[Title]]`` should resolve to in the renderer.

    Always equal to :func:`base_slug` — collision suffixes mean a wiki-link can
    legitimately fail to resolve, in which case the renderer marks it as broken.
    """
    return base_slug(title)
