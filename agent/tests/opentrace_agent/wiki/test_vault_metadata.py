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
    PageMeta,
    VaultMetadata,
    load_metadata,
    save_metadata,
)


def test_roundtrip(tmp_path: Path):
    meta = VaultMetadata.empty("v1")
    meta.sources["a" * 64] = IngestedSource(
        sha256="a" * 64, original_name="x.md", ingested_at="t", contributed_to=["foo"]
    )
    meta.pages["foo"] = PageMeta(slug="foo", title="Foo", one_line_summary="about foo", source_shas=["a" * 64])
    meta.tombstones.append("old-page")
    path = tmp_path / ".vault.json"
    save_metadata(path, meta)
    reloaded = load_metadata(path, name="v1")
    assert reloaded.name == "v1"
    assert "foo" in reloaded.pages
    assert reloaded.pages["foo"].title == "Foo"
    assert "a" * 64 in reloaded.sources
    assert reloaded.tombstones == ["old-page"]


def test_load_missing_returns_empty(tmp_path: Path):
    meta = load_metadata(tmp_path / "absent.json", name="empty")
    assert meta.name == "empty"
    assert meta.pages == {}
    assert meta.sources == {}


def test_old_metadata_without_kind_loads_as_concept(tmp_path: Path):
    """Vaults compiled before the source/concept split must still load."""
    legacy = """{
        "name": "legacy",
        "schema_version": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "last_compiled_at": null,
        "sources": {},
        "tombstones": [],
        "pages": {
            "ducks": {
                "slug": "ducks",
                "title": "Ducks",
                "one_line_summary": "About ducks.",
                "source_shas": [],
                "last_updated": "2026-01-01T00:00:00+00:00",
                "revision": 1
            }
        }
    }"""
    p = tmp_path / ".vault.json"
    p.write_text(legacy)
    meta = load_metadata(p, name="legacy")
    assert meta.pages["ducks"].kind == "concept"


def test_legacy_source_kind_loads_as_source_summary(tmp_path: Path):
    """Vaults compiled before the source-summary rename used kind='source'.
    Loading them should map the old value onto the new 'source_summary' kind
    so the UI grouping continues to work without re-compilation."""
    legacy = """{
        "name": "legacy",
        "schema_version": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "last_compiled_at": null,
        "sources": {},
        "tombstones": [],
        "pages": {
            "source-ducks": {
                "slug": "source-ducks",
                "title": "Source: Ducks",
                "one_line_summary": "Ducks doc.",
                "source_shas": [],
                "last_updated": "2026-01-01T00:00:00+00:00",
                "revision": 1,
                "kind": "source"
            }
        }
    }"""
    p = tmp_path / ".vault.json"
    p.write_text(legacy)
    meta = load_metadata(p, name="legacy")
    assert meta.pages["source-ducks"].kind == "source_summary"
