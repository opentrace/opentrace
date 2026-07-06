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

"""Page title → filesystem slug, with collision suffixes and tombstone awareness.

Slugs are path-like: ``<kind_dir>/<base>`` (e.g. ``concept/usage``). The
``<kind_dir>`` segment namespaces page kinds against each other — it also
doubles as the on-disk folder and the Obsidian-visible page-path prefix.
Concept is the only kind produced today; the structure stays kind-shaped
so a future kind slots in without a layout migration.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

MAX_SLUG_LEN = 80
_NON_ALNUM = re.compile(r"[^a-z0-9]+")

# kind value (as stored in PageMeta.kind / CompiledPage.kind) → folder name.
_KIND_DIRS = {
    "concept": "concept",
}


def kind_dir(kind: str) -> str:
    """Map a page kind to its on-disk folder name.

    Unknown kinds fall back to ``concept`` so callers that pass a stale
    legacy value (e.g. raw ``"source"``) don't produce a fresh top-level
    folder per typo.
    """
    return _KIND_DIRS.get(kind, "concept")


def base_slug(title: str) -> str:
    """Return the base (suffix-free, prefix-free) slug for *title*.

    Lowercased, ASCII-folded, non-alphanumeric runs collapsed to a single dash,
    truncated to MAX_SLUG_LEN. Empty input yields ``"untitled"``. Does NOT
    include the kind folder — use :func:`unique_slug` to get the full
    ``<kind_dir>/<base>`` slug.
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
    kind: str = "concept",
    existing: Iterable[str],
    tombstones: Iterable[str] = (),
) -> str:
    """Pick a fresh ``<kind_dir>/<base>`` slug that doesn't collide.

    Suffixes ``-2``, ``-3``, ... are appended to the base on collision.
    Tombstones reserve slugs of pages that previously existed so old
    ``[[wiki-links]]`` don't silently retarget. Collisions are scoped per
    kind by construction: the ``<kind_dir>/`` prefix is the namespace.
    """
    used = set(existing) | set(tombstones)
    dir_ = kind_dir(kind)
    base = base_slug(title)
    candidate = f"{dir_}/{base}"
    if candidate not in used:
        return candidate
    n = 2
    while True:
        candidate = f"{dir_}/{base}-{n}"
        if candidate not in used:
            return candidate
        n += 1


def title_to_link_slug(title: str, *, kind: str = "concept") -> str:
    """The slug that ``[[Title]]`` should resolve to in the renderer.

    Always equal to ``<kind_dir>/<base_slug>`` for the given *kind* —
    collision suffixes mean a wiki-link can legitimately fail to resolve,
    in which case the renderer marks it as broken.
    """
    return f"{kind_dir(kind)}/{base_slug(title)}"
