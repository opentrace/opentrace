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
        sha256="a" * 64, original_name="x.md", ingested_at="t", contributed_to=["concept/foo"]
    )
    meta.pages["concept/foo"] = PageMeta(
        slug="concept/foo", title="Foo", one_line_summary="about foo", source_shas=["a" * 64]
    )
    meta.tombstones.append("concept/old-page")
    path = tmp_path / ".vault.json"
    save_metadata(path, meta)
    reloaded = load_metadata(path, name="v1")
    assert reloaded.name == "v1"
    assert "concept/foo" in reloaded.pages
    assert reloaded.pages["concept/foo"].title == "Foo"
    assert reloaded.pages["concept/foo"].kind == "concept"
    assert "a" * 64 in reloaded.sources
    assert reloaded.tombstones == ["concept/old-page"]


def test_load_missing_returns_empty(tmp_path: Path):
    meta = load_metadata(tmp_path / "absent.json", name="empty")
    assert meta.name == "empty"
    assert meta.pages == {}
    assert meta.sources == {}


def test_metadata_without_kind_field_defaults_to_concept(tmp_path: Path):
    """``kind`` has a dataclass default — records without it load as concept."""
    p = tmp_path / ".vault.json"
    p.write_text(
        """{
        "name": "v",
        "schema_version": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "last_compiled_at": null,
        "sources": {},
        "tombstones": [],
        "pages": {
            "concept/ducks": {
                "slug": "concept/ducks",
                "title": "Ducks",
                "one_line_summary": "About ducks.",
                "source_shas": [],
                "last_updated": "2026-01-01T00:00:00+00:00",
                "revision": 1
            }
        }
    }"""
    )
    meta = load_metadata(p, name="v")
    assert meta.pages["concept/ducks"].kind == "concept"
