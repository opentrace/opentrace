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
    migrate_disk_layout,
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
    assert "a" * 64 in reloaded.sources
    assert reloaded.tombstones == ["concept/old-page"]


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
    # Flat ``ducks`` slug migrates to ``concept/ducks``.
    assert "concept/ducks" in meta.pages
    assert meta.pages["concept/ducks"].kind == "concept"
    assert meta.pages["concept/ducks"].slug == "concept/ducks"


def test_legacy_source_kind_loads_as_file_summary(tmp_path: Path):
    """Vaults compiled before the file-summary rename used kind='source'.
    Loading them should map the old value onto the new 'file_summary' kind
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
    # Flat slug migrates into the file-summary folder.
    assert "file-summary/source-ducks" in meta.pages
    page = meta.pages["file-summary/source-ducks"]
    assert page.kind == "file_summary"
    # Legacy "Source: " / "Source Summary: " title prefix is stripped on load
    # — the prefix is now redundant because the sidebar groups file-summary
    # pages under their own section.
    assert page.title == "Ducks"


def test_legacy_source_summary_title_prefix_is_stripped(tmp_path: Path):
    legacy = """{
        "name": "legacy",
        "schema_version": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "last_compiled_at": null,
        "sources": {},
        "tombstones": [],
        "pages": {
            "source-summary-quarterly": {
                "slug": "source-summary-quarterly",
                "title": "Source Summary: Quarterly Report",
                "one_line_summary": "Q4 figures.",
                "source_shas": [],
                "last_updated": "2026-01-01T00:00:00+00:00",
                "revision": 1,
                "kind": "source_summary"
            }
        }
    }"""
    p = tmp_path / ".vault.json"
    p.write_text(legacy)
    meta = load_metadata(p, name="legacy")
    # The ``source-summary-`` filename prefix is no longer needed because
    # the page now lives under the ``file-summary/`` folder, and the
    # pre-rename "source_summary" kind folds into "file_summary".
    assert "file-summary/quarterly" in meta.pages
    assert meta.pages["file-summary/quarterly"].kind == "file_summary"
    assert meta.pages["file-summary/quarterly"].title == "Quarterly Report"


def test_pre_rename_kind_folder_slug_is_migrated(tmp_path: Path):
    """Vaults compiled while these pages were called "source summaries"
    used kind="source_summary" and slugs under ``source-summary/``; both
    rename to file-summary on load."""
    legacy = """{
        "name": "legacy",
        "schema_version": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "last_compiled_at": null,
        "sources": {},
        "tombstones": ["source-summary/old-doc"],
        "pages": {
            "source-summary/quarterly": {
                "slug": "source-summary/quarterly",
                "title": "Quarterly Report",
                "one_line_summary": "Q4 figures.",
                "source_shas": [],
                "last_updated": "2026-01-01T00:00:00+00:00",
                "revision": 1,
                "kind": "source_summary"
            }
        }
    }"""
    p = tmp_path / ".vault.json"
    p.write_text(legacy)
    meta = load_metadata(p, name="legacy")
    assert "file-summary/quarterly" in meta.pages
    assert meta.pages["file-summary/quarterly"].kind == "file_summary"
    assert meta.tombstones == ["file-summary/old-doc"]


def test_legacy_tombstones_are_migrated(tmp_path: Path):
    legacy = """{
        "name": "legacy",
        "schema_version": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "last_compiled_at": null,
        "sources": {},
        "tombstones": ["old-concept", "source-summary-old-doc"],
        "pages": {}
    }"""
    p = tmp_path / ".vault.json"
    p.write_text(legacy)
    meta = load_metadata(p, name="legacy")
    assert "concept/old-concept" in meta.tombstones
    assert "file-summary/old-doc" in meta.tombstones


def test_migrate_disk_layout_moves_flat_files(tmp_path: Path):
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "ducks.md").write_text("# Ducks\n")
    (pages / "source-summary-quarterly.md").write_text("# Quarterly Report\n")

    meta = VaultMetadata.empty("v")
    meta.pages = {
        "concept/ducks": PageMeta(slug="concept/ducks", title="Ducks", one_line_summary="x", kind="concept"),
        "file-summary/quarterly": PageMeta(
            slug="file-summary/quarterly",
            title="Quarterly Report",
            one_line_summary="x",
            kind="file_summary",
        ),
    }

    moved = migrate_disk_layout(meta, pages)
    assert moved == 2
    assert (pages / "concept" / "ducks.md").exists()
    assert (pages / "file-summary" / "quarterly.md").exists()
    # Original flat files are gone.
    assert not (pages / "ducks.md").exists()
    assert not (pages / "source-summary-quarterly.md").exists()


def test_migrate_disk_layout_moves_pre_rename_kind_folder(tmp_path: Path):
    pages = tmp_path / "pages"
    (pages / "source-summary").mkdir(parents=True)
    (pages / "source-summary" / "quarterly.md").write_text("# Quarterly Report\n")

    meta = VaultMetadata.empty("v")
    meta.pages = {
        "file-summary/quarterly": PageMeta(
            slug="file-summary/quarterly",
            title="Quarterly Report",
            one_line_summary="x",
            kind="file_summary",
        ),
    }

    assert migrate_disk_layout(meta, pages) == 1
    assert (pages / "file-summary" / "quarterly.md").exists()
    assert not (pages / "source-summary" / "quarterly.md").exists()


def test_migrate_disk_layout_is_idempotent(tmp_path: Path):
    pages = tmp_path / "pages"
    (pages / "concept").mkdir(parents=True)
    (pages / "concept" / "ducks.md").write_text("# Ducks\n")

    meta = VaultMetadata.empty("v")
    meta.pages = {
        "concept/ducks": PageMeta(slug="concept/ducks", title="Ducks", one_line_summary="x", kind="concept"),
    }

    assert migrate_disk_layout(meta, pages) == 0
    assert (pages / "concept" / "ducks.md").exists()
