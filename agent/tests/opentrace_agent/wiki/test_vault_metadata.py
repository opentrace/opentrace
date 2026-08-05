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

from pathlib import Path

from opentrace_agent.wiki.vault import (
    IngestedSource,
    VaultMetadata,
    load_metadata,
    save_metadata,
)


def test_roundtrip(tmp_path: Path):
    meta = VaultMetadata.empty("v1")
    meta.sources["a" * 64] = IngestedSource(
        sha256="a" * 64,
        original_name="x.md",
        ingested_at="t",
        title="X",
        one_line_summary="about x",
        status="design_history",
    )
    meta.spawned_from = "dir::/tmp/docs"
    path = tmp_path / ".vault.json"
    save_metadata(path, meta)
    reloaded = load_metadata(path, name="v1")
    assert reloaded.name == "v1"
    assert reloaded.spawned_from == "dir::/tmp/docs"
    src = reloaded.sources["a" * 64]
    assert src.original_name == "x.md"
    assert src.title == "X"
    assert src.one_line_summary == "about x"
    assert src.status == "design_history"


def test_load_missing_returns_empty(tmp_path: Path):
    meta = load_metadata(tmp_path / "absent.json", name="empty")
    assert meta.name == "empty"
    assert meta.sources == {}


def test_status_defaults_when_absent(tmp_path: Path):
    """``status`` has a dataclass default — pre-status records load as authoritative."""
    p = tmp_path / ".vault.json"
    p.write_text(
        """{
        "name": "v",
        "schema_version": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "last_compiled_at": null,
        "sources": {
            "b": {"sha256": "b", "original_name": "d.md", "ingested_at": "t"}
        }
    }"""
    )
    assert load_metadata(p, name="v").sources["b"].status == "authoritative"


def test_legacy_page_layer_keys_are_ignored(tmp_path: Path):
    """A ``.vault.json`` written before 2026-08-04 carries the concept-page
    layer's fields: top-level ``pages`` / ``tombstones`` and a per-source
    ``contributed_to`` list of page slugs. Splatting the latter into
    ``IngestedSource`` would raise TypeError and make the vault unloadable, so
    unknown keys are dropped — the documents still load."""
    p = tmp_path / ".vault.json"
    p.write_text(
        """{
        "name": "v",
        "schema_version": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "last_compiled_at": null,
        "tombstones": ["concept/old-page"],
        "pages": {
            "concept/ducks": {
                "slug": "concept/ducks",
                "title": "Ducks",
                "one_line_summary": "About ducks.",
                "source_shas": ["c"],
                "revision": 1
            }
        },
        "sources": {
            "c": {
                "sha256": "c",
                "original_name": "ducks.md",
                "ingested_at": "t",
                "contributed_to": ["concept/ducks"]
            }
        }
    }"""
    )
    meta = load_metadata(p, name="v")
    assert meta.sources["c"].original_name == "ducks.md"
    # Nothing page-shaped survives the load.
    assert not hasattr(meta, "pages")
    assert not hasattr(meta, "tombstones")
    assert not hasattr(meta.sources["c"], "contributed_to")
