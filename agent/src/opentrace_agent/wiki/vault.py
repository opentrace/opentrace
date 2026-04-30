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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
            # Legacy alias: vaults compiled before the rename used kind="source"
            # for what we now call source-summary pages. Treat it as the new value.
            if v.get("kind") == "source":
                v = {**v, "kind": "source_summary"}
            pages[slug] = PageMeta(**v)
        return cls(
            name=data["name"],
            schema_version=data.get("schema_version", SCHEMA_VERSION),
            created_at=data.get("created_at") or _now(),
            last_compiled_at=data.get("last_compiled_at"),
            sources=sources,
            pages=pages,
            tombstones=list(data.get("tombstones") or []),
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
