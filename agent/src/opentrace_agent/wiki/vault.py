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
from dataclasses import asdict, dataclass, field, fields
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
    # Navigation label from the per-doc extraction call. Persisted here so a
    # disk-only vault (e.g. a global compiled without a graph store) keeps
    # its labels for a later ``vault attach`` to mirror onto KnowledgeDocs.
    title: str = ""
    one_line_summary: str = ""
    # Epistemic status ("authoritative" | "design_history" |
    # "design_history_archived"); default keeps old .vault.json loadable.
    status: str = "authoritative"


# Field names ``IngestedSource`` accepts on load. A ``.vault.json`` written by
# another build can carry keys this build does not declare; splatting those
# straight in would raise TypeError and make the vault unloadable, so unknown
# keys are ignored instead.
_INGESTED_SOURCE_FIELDS = frozenset(f.name for f in fields(IngestedSource))


@dataclass
class VaultMetadata:
    name: str
    schema_version: int = SCHEMA_VERSION
    created_at: str = field(default_factory=_now)
    last_compiled_at: str | None = None
    sources: dict[str, IngestedSource] = field(default_factory=dict)
    # Repository id this vault was spawned from by ``index --wiki`` over a repo
    # (None for uploads / URLs / single files). Persisted so a re-index of the
    # same repo finds and updates the vault it created before — even when the
    # vault's name was auto-suffixed to avoid a cross-scope collision — instead
    # of minting a new suffixed vault every run.
    spawned_from: str | None = None

    @classmethod
    def empty(cls, name: str) -> VaultMetadata:
        return cls(name=name)

    def to_json(self) -> str:
        payload = asdict(self)
        return json.dumps(payload, indent=2, sort_keys=True)

    @classmethod
    def from_json(cls, text: str) -> VaultMetadata:
        data = json.loads(text)
        sources = {
            sha: IngestedSource(**{k: v2 for k, v2 in v.items() if k in _INGESTED_SOURCE_FIELDS})
            for sha, v in (data.get("sources") or {}).items()
        }
        return cls(
            name=data["name"],
            schema_version=data.get("schema_version", SCHEMA_VERSION),
            created_at=data.get("created_at") or _now(),
            last_compiled_at=data.get("last_compiled_at"),
            sources=sources,
            spawned_from=data.get("spawned_from"),
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
