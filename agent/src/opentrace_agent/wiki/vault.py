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

"""Vault metadata model + atomic ``.vault.json`` read/write."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

# Legacy filename prefix that file-summary pages (then called "source
# summaries") used to carry before the folders-by-kind slug layout. We
# strip it on load and re-key under ``file-summary/<base>``. Kept as a
# module-level constant so the migration logic in
# :func:`PageMeta.from_json` and the on-disk migration in
# :func:`migrate_disk_layout` agree on the exact prefix.
_LEGACY_FLAT_PREFIX = "source-summary-"

# Slug directory these pages lived under while they were called "source
# summaries"; rewritten to ``file-summary/`` on load.
_LEGACY_KIND_DIR = "source-summary/"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _migrate_flat_slug(flat_slug: str, kind: str) -> str:
    """Promote a legacy flat slug to ``<kind_dir>/<base>``.

    Slugs that already contain a ``/`` only get the source-summary →
    file-summary directory rename. For file-summary pages, strips the
    redundant ``source-summary-`` filename prefix that used to
    disambiguate them in a flat layout — the folder now serves that role.
    """
    if "/" in flat_slug:
        if flat_slug.startswith(_LEGACY_KIND_DIR):
            return f"file-summary/{flat_slug[len(_LEGACY_KIND_DIR) :]}"
        return flat_slug
    if kind == "file_summary":
        bare = flat_slug
        if bare.startswith(_LEGACY_FLAT_PREFIX):
            bare = bare[len(_LEGACY_FLAT_PREFIX) :]
        return f"file-summary/{bare}"
    return f"concept/{flat_slug}"


def _guess_kind_for_tombstone(slug: str) -> str:
    """Guess the kind of a tombstoned slug from its legacy filename prefix.

    Tombstones don't carry their original ``kind`` — we infer from the
    ``source-summary-`` prefix that the flat layout used. Anything else
    is treated as a concept tombstone.
    """
    if slug.startswith(_LEGACY_FLAT_PREFIX):
        return "file_summary"
    return "concept"


@dataclass
class IngestedSource:
    sha256: str
    original_name: str
    ingested_at: str
    contributed_to: list[str] = field(default_factory=list)


@dataclass
class PageMeta:
    slug: str
    title: str
    one_line_summary: str
    source_shas: list[str] = field(default_factory=list)
    last_updated: str = ""
    revision: int = 1
    # "source" for one-per-uploaded-file summary pages; "concept" for the
    # cross-source synthesis pages decided by Plan. Old vault.json files
    # without this field load as "concept" for back-compat.
    kind: str = "concept"


@dataclass
class VaultMetadata:
    name: str
    schema_version: int = SCHEMA_VERSION
    created_at: str = field(default_factory=_now)
    last_compiled_at: str | None = None
    sources: dict[str, IngestedSource] = field(default_factory=dict)
    pages: dict[str, PageMeta] = field(default_factory=dict)
    tombstones: list[str] = field(default_factory=list)

    @classmethod
    def empty(cls, name: str) -> VaultMetadata:
        return cls(name=name)

    def to_json(self) -> str:
        payload = asdict(self)
        return json.dumps(payload, indent=2, sort_keys=True)

    @classmethod
    def from_json(cls, text: str) -> VaultMetadata:
        data = json.loads(text)
        sources = {sha: IngestedSource(**v) for sha, v in (data.get("sources") or {}).items()}
        pages: dict[str, PageMeta] = {}
        for slug, v in (data.get("pages") or {}).items():
            # Legacy aliases: these pages were first kind="source", then
            # kind="source_summary"; both fold into the current value.
            if v.get("kind") in ("source", "source_summary"):
                v = {**v, "kind": "file_summary"}
            # Legacy title prefix: file-summary pages used to be titled
            # "Source Summary: <Name>" — the prefix is now redundant because
            # the sidebar groups them under their own section and the planner
            # identifies them by kind. Strip it on load so existing vaults
            # show the same clean title as freshly-compiled ones.
            if v.get("kind") == "file_summary":
                title = v.get("title") or ""
                if title.startswith("Source Summary: "):
                    v = {**v, "title": title[len("Source Summary: ") :]}
                elif title.startswith("Source: "):
                    v = {**v, "title": title[len("Source: ") :]}
            # Legacy flat slug → ``<kind_dir>/<base>``. Slugs from before the
            # folders-by-kind layout were either ``source-summary-<base>``
            # (for kind=file_summary) or just ``<base>`` (concept); after
            # migration both live under a kind folder so identical titles
            # across kinds no longer collide.
            new_slug = _migrate_flat_slug(slug, v.get("kind", "concept"))
            v = {**v, "slug": new_slug}
            pages[new_slug] = PageMeta(**v)
        raw_tombstones = list(data.get("tombstones") or [])
        tombstones = [_migrate_flat_slug(t, _guess_kind_for_tombstone(t)) for t in raw_tombstones]
        return cls(
            name=data["name"],
            schema_version=data.get("schema_version", SCHEMA_VERSION),
            created_at=data.get("created_at") or _now(),
            last_compiled_at=data.get("last_compiled_at"),
            sources=sources,
            pages=pages,
            tombstones=tombstones,
        )


def load_metadata(path: Path, *, name: str) -> VaultMetadata:
    """Load metadata from *path*; if missing, return an empty metadata for *name*."""
    if not path.exists():
        return VaultMetadata.empty(name)
    return VaultMetadata.from_json(path.read_text())


def save_metadata(path: Path, meta: VaultMetadata) -> None:
    """Write metadata atomically: write to ``.tmp`` then ``os.replace``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".vault.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(meta.to_json())
        os.replace(tmp_path, path)
    except BaseException:
        Path(tmp_path).unlink(missing_ok=True)
        raise


def migrate_disk_layout(meta: VaultMetadata, pages_dir: Path) -> int:
    """Move legacy page files into the current kind-folder layout.

    Called once per compile right after the on-disk metadata has been
    loaded (slugs in *meta* are already in the new ``<kind_dir>/<base>``
    form). For each page whose new slug lives inside a kind folder, we
    look for a file at each legacy path — the flat pre-kind-folder layout,
    or the ``source-summary/`` folder from before the file-summary rename —
    and ``os.replace`` it to the new location. Idempotent: skips pages
    whose new file already exists or whose legacy file is missing (the
    common case for freshly-compiled vaults).

    Returns the number of files moved (zero when the vault is already in
    the new layout).
    """
    moved = 0
    for slug, page in meta.pages.items():
        if "/" not in slug:
            # Defensive: shouldn't happen after `from_json` migration but
            # leaves us a no-op safe path.
            continue
        new_path = pages_dir / f"{slug}.md"
        if new_path.exists():
            continue
        # Reverse the migration to recover the legacy locations: a
        # file-summary's flat slug carried the ``source-summary-`` prefix
        # on its base, and its pre-rename kind folder was
        # ``source-summary/``; a concept's flat base is the slug as-is.
        base = slug.split("/", 1)[1]
        if page.kind == "file_summary":
            legacy_paths = [
                pages_dir / f"{_LEGACY_FLAT_PREFIX}{base}.md",
                pages_dir / _LEGACY_KIND_DIR / f"{base}.md",
            ]
        else:
            legacy_paths = [pages_dir / f"{base}.md"]
        legacy_path = next((p for p in legacy_paths if p.exists()), None)
        if legacy_path is None:
            continue
        new_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(legacy_path, new_path)
        moved += 1
    return moved
