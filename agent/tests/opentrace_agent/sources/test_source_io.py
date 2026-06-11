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

"""Pure unit tests for the corpus-IO helpers (no DB, no markitdown)."""

from __future__ import annotations

import pytest

from opentrace_agent.sources.markdown import AnnotatedMarkdown
from opentrace_agent.sources.markdown.source_io import (
    CORPUS_SUBDIR,
    corpus_dir,
    load_source_markdown,
    relative_corpus_path,
    write_source_markdown,
)


class TestRelativeCorpusPath:
    def test_basic(self):
        assert relative_corpus_path("src_abc") == "corpus/src_abc.md"

    def test_colon_replaced(self):
        # Source IDs include "src:<hash>"; the colon would confuse filesystems
        # on some platforms — verify it's normalised.
        assert relative_corpus_path("src:1234") == "corpus/src_1234.md"

    def test_slash_replaced(self):
        # A stray slash in the id would create unintended subdirectories.
        assert relative_corpus_path("src/x") == "corpus/src_x.md"


class TestCorpusDir:
    def test_anchored_at_db_parent(self, tmp_path):
        # db at .opentrace/index.db → corpus at .opentrace/corpus/
        db = tmp_path / ".opentrace" / "index.db"
        db.parent.mkdir(parents=True)
        assert corpus_dir(db) == tmp_path / ".opentrace" / CORPUS_SUBDIR


class TestWriteAndLoadRoundTrip:
    def test_write_creates_file(self, tmp_path):
        db = tmp_path / "db"
        annotated = AnnotatedMarkdown(
            markdown="# Hi\nbody",
            source_uri="file:///x",
            source_type="markdown",
        )
        rel = write_source_markdown(db, "src:1", annotated)
        assert rel == "corpus/src_1.md"
        full = tmp_path / rel
        assert full.exists()
        assert full.read_text() == "# Hi\nbody"

    def test_write_creates_corpus_dir_if_missing(self, tmp_path):
        # Don't pre-create the corpus dir.
        db = tmp_path / "db"
        write_source_markdown(
            db,
            "src:1",
            AnnotatedMarkdown(markdown="x", source_uri="u", source_type="t"),
        )
        assert (tmp_path / CORPUS_SUBDIR).is_dir()

    def test_write_overwrites_existing_file(self, tmp_path):
        db = tmp_path / "db"
        a = AnnotatedMarkdown(markdown="v1", source_uri="u", source_type="t")
        b = AnnotatedMarkdown(markdown="v2", source_uri="u", source_type="t")
        rel = write_source_markdown(db, "src:1", a)
        write_source_markdown(db, "src:1", b)
        assert (tmp_path / rel).read_text() == "v2"

    def test_load_round_trip(self, tmp_path):
        db = tmp_path / "db"
        original = AnnotatedMarkdown(
            markdown="# Topic\nDetails.",
            source_uri="https://example.com/x",
            source_type="html",
            title="Topic",
            fetched_at="2026-05-14T10:00:00Z",
        )
        rel = write_source_markdown(db, "src:abc", original)
        node = {
            "id": "src:abc",
            "type": "Source",
            "name": "Topic",
            "properties": {
                "source_uri": original.source_uri,
                "source_type": original.source_type,
                "title": original.title,
                "fetched_at": original.fetched_at,
                "corpus_path": rel,
            },
        }
        loaded = load_source_markdown(db, node)
        assert loaded.markdown == original.markdown
        assert loaded.source_uri == original.source_uri
        assert loaded.source_type == original.source_type
        assert loaded.title == original.title
        assert loaded.fetched_at == original.fetched_at

    def test_load_without_corpus_path_raises(self, tmp_path):
        node = {"id": "src:x", "properties": {"source_uri": "u"}}
        with pytest.raises(ValueError, match="corpus_path"):
            load_source_markdown(tmp_path / "db", node)

    def test_load_with_missing_file_raises(self, tmp_path):
        node = {
            "id": "src:x",
            "properties": {"corpus_path": "corpus/missing.md", "source_uri": "u"},
        }
        with pytest.raises(FileNotFoundError):
            load_source_markdown(tmp_path / "db", node)

    def test_load_handles_unicode(self, tmp_path):
        db = tmp_path / "db"
        original = AnnotatedMarkdown(
            markdown="émoji ✨ test — résumé",
            source_uri="u",
            source_type="t",
        )
        rel = write_source_markdown(db, "src:u", original)
        node = {
            "id": "src:u",
            "properties": {"corpus_path": rel, "source_uri": "u", "source_type": "t"},
        }
        loaded = load_source_markdown(db, node)
        assert loaded.markdown == original.markdown


class TestScopeAwareCorpus:
    """Coverage for the scope-aware helpers that let global vaults
    keep a corpus next to their disk vault, independent of any
    project's graph DB."""

    def test_corpus_dir_for_scope_local(self, tmp_path):
        from opentrace_agent.sources.markdown import corpus_dir_for_scope

        result = corpus_dir_for_scope("local", project_root=tmp_path)
        assert result == (tmp_path / ".opentrace" / CORPUS_SUBDIR).resolve()

    def test_corpus_dir_for_scope_global_respects_env(self, tmp_path, monkeypatch):
        from opentrace_agent.sources.markdown import corpus_dir_for_scope

        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "vaults"))
        # Sibling of the vault root.
        assert corpus_dir_for_scope("global") == tmp_path / CORPUS_SUBDIR

    def test_write_corpus_markdown_to_returns_relative_path(self, tmp_path):
        from opentrace_agent.sources.markdown import write_corpus_markdown_to

        cdir = tmp_path / CORPUS_SUBDIR
        rel = write_corpus_markdown_to(cdir, "src:abc", "hello")
        # Returned path is the same portable form as the project-local
        # writer — the caller stores it on Source.corpus_path.
        assert rel == "corpus/src_abc.md"
        assert (cdir / "src_abc.md").read_text() == "hello"

    def test_copy_corpus_between_scopes_copies_missing(self, tmp_path, monkeypatch):
        from opentrace_agent.sources.markdown import (
            copy_corpus_between_scopes,
            corpus_dir_for_scope,
            write_corpus_markdown_to,
        )

        # Two distinct corpus dirs: one global, one project-local.
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "g" / "vaults"))
        project = tmp_path / "p"
        gdir = corpus_dir_for_scope("global")
        ldir = corpus_dir_for_scope("local", project_root=project)

        write_corpus_markdown_to(gdir, "src:1", "one")
        write_corpus_markdown_to(gdir, "src:2", "two")

        result = copy_corpus_between_scopes(
            ["src:1", "src:2", "src:missing"],
            from_scope="global",
            to_scope="local",
            to_project_root=project,
        )
        assert result == {
            "src:1": "corpus/src_1.md",
            "src:2": "corpus/src_2.md",
        }
        assert (ldir / "src_1.md").read_text() == "one"
        assert (ldir / "src_2.md").read_text() == "two"
        assert not (ldir / "src_missing.md").exists()

    def test_copy_corpus_between_scopes_same_dir_is_existence_check(self, tmp_path, monkeypatch):
        from opentrace_agent.sources.markdown import (
            copy_corpus_between_scopes,
            corpus_dir_for_scope,
            write_corpus_markdown_to,
        )

        # Local scope's project_root is the same in both args — same dir.
        cdir = corpus_dir_for_scope("local", project_root=tmp_path)
        write_corpus_markdown_to(cdir, "src:1", "one")
        result = copy_corpus_between_scopes(
            ["src:1", "src:missing"],
            from_scope="local",
            to_scope="local",
            from_project_root=tmp_path,
            to_project_root=tmp_path,
        )
        # Returned only for files that exist; no extra writes.
        assert result == {"src:1": "corpus/src_1.md"}
