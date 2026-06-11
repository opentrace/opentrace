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

"""Tests for the markdown ingestion layer."""

from __future__ import annotations

import pytest

pytest.importorskip("markitdown")

from opentrace_agent.sources.markdown import (  # noqa: E402
    AnnotatedMarkdown,
    UnsupportedSourceError,
    convert,
    detect_source_type,
    resolve,
)


class TestDetectSourceType:
    @pytest.mark.parametrize(
        "input_, expected",
        [
            ("/tmp/notes.pdf", "pdf"),
            ("/tmp/spec.docx", "word"),
            ("deck.pptx", "powerpoint"),
            ("data.xlsx", "excel"),
            ("rows.csv", "csv"),
            ("book.epub", "epub"),
            ("img.png", "image"),
            ("song.mp3", "audio"),
            ("video.mp4", "video"),
            ("notes.md", "markdown"),
            ("readme.txt", "text"),
            ("https://example.com/", "html"),
            ("https://example.com/file.pdf", "pdf"),
            ("https://arxiv.org/abs/2301.00001", "arxiv"),
            ("https://youtube.com/watch?v=abc", "youtube"),
            ("https://youtu.be/abc", "youtube"),
            ("/unknown.xyz", "unknown"),
        ],
    )
    def test_classification(self, input_, expected):
        assert detect_source_type(input_) == expected


class TestResolveFetcher:
    def test_arxiv_abs_rewritten_to_pdf(self):
        url = "https://arxiv.org/abs/2301.00001"
        assert resolve(url) == "https://arxiv.org/pdf/2301.00001.pdf"

    def test_arxiv_versioned_id_preserved(self):
        url = "https://arxiv.org/abs/2301.00001v2"
        assert resolve(url) == "https://arxiv.org/pdf/2301.00001v2.pdf"

    def test_arxiv_pdf_passthrough(self):
        url = "https://arxiv.org/pdf/2301.00001.pdf"
        assert resolve(url) == url

    def test_html_url_passthrough(self):
        url = "https://example.com/article"
        assert resolve(url) == url

    def test_local_path_passthrough(self):
        assert resolve("/tmp/notes.pdf") == "/tmp/notes.pdf"

    @pytest.mark.parametrize(
        "url",
        [
            "https://twitter.com/anthropic/status/123",
            "https://x.com/anthropic/status/456",
            "https://mobile.twitter.com/anthropic/status/789",
        ],
    )
    def test_twitter_raises(self, url):
        with pytest.raises(UnsupportedSourceError, match="X/Twitter"):
            resolve(url)


class TestConvertLocal:
    """Round-trip a local markdown file through the loader."""

    def test_markdown_file_round_trip(self, tmp_path):
        md = tmp_path / "in.md"
        md.write_text("# Title\n\nbody text here\n")
        result = convert(str(md))
        assert isinstance(result, AnnotatedMarkdown)
        assert "body text here" in result.markdown
        assert result.source_type == "markdown"
        assert result.source_uri == str(md)
        assert result.fetched_at  # timestamp populated

    def test_html_file_converts_to_markdown(self, tmp_path):
        html = tmp_path / "page.html"
        html.write_text("<html><body><h1>Heading</h1><p>Paragraph one.</p></body></html>")
        result = convert(str(html))
        assert "Heading" in result.markdown
        assert "Paragraph one" in result.markdown
        assert result.source_type == "html"

    def test_csv_file_converts(self, tmp_path):
        csv = tmp_path / "rows.csv"
        csv.write_text("name,kind\nfoo,service\nbar,database\n")
        result = convert(str(csv))
        assert "foo" in result.markdown
        assert result.source_type == "csv"


class TestFrontmatter:
    def test_with_frontmatter_emits_header(self):
        a = AnnotatedMarkdown(
            markdown="body",
            source_uri="https://example.com",
            source_type="html",
            title="Example",
            fetched_at="2026-05-14T10:00:00Z",
        )
        out = a.with_frontmatter()
        assert out.startswith("---\n")
        assert 'source_uri: "https://example.com"' in out
        assert "source_type: html" in out
        assert 'title: "Example"' in out
        assert "fetched_at: 2026-05-14T10:00:00Z" in out
        assert out.endswith("body")

    def test_yaml_escapes_quotes(self):
        a = AnnotatedMarkdown(
            markdown="x",
            source_uri='https://a.com/path?q="weird"',
            source_type="html",
        )
        out = a.with_frontmatter()
        # The unescaped " would break YAML; the escaped form survives.
        assert '\\"weird\\"' in out

    def test_metadata_only_includes_primitives(self):
        a = AnnotatedMarkdown(
            markdown="x",
            source_uri="u",
            source_type="t",
            metadata={"page_count": 12, "author": "anon", "complex": {"nested": 1}},
        )
        out = a.with_frontmatter()
        assert 'page_count: "12"' in out
        assert 'author: "anon"' in out
        # Nested structures are skipped — they stay in the dataclass only.
        assert "nested" not in out


class TestMissingDependency:
    def test_actionable_error_when_markitdown_missing(self, monkeypatch):
        import sys

        original = sys.modules.pop("markitdown", None)
        sys.modules["markitdown"] = None  # type: ignore[assignment]
        try:
            with pytest.raises(RuntimeError, match="markitdown not installed"):
                convert("/tmp/notes.md")
        finally:
            sys.modules.pop("markitdown", None)
            if original is not None:
                sys.modules["markitdown"] = original
