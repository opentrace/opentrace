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

"""Tests for the Normalize stage — passthrough routing and the markitdown
UTF-8 fallback that keeps non-ASCII text formats from being dropped."""

from __future__ import annotations

from opentrace_agent.wiki.ingest.normalize import (
    _is_passthrough,
    _markitdown_convert,
    _passthrough,
    normalize,
)
from opentrace_agent.wiki.ingest.sources import AcquiredSource
from opentrace_agent.wiki.ingest.types import WikiEventKind


class TestPassthrough:
    def test_rst_is_passthrough(self):
        # Regression: .rst routed through markitdown, whose PlainTextConverter
        # decodes as ASCII and dies on em-dashes / smart quotes.
        assert _is_passthrough("docs/config.rst")
        assert _is_passthrough("README.md")
        assert _is_passthrough("notes.txt")

    def test_binary_formats_not_passthrough(self):
        assert not _is_passthrough("report.pdf")
        assert not _is_passthrough("deck.pptx")

    def test_passthrough_decodes_utf8_non_ascii(self):
        # 0xE2 0x80 0x94 is an em-dash — the exact byte the ASCII decode choked on.
        text = _passthrough("a — b".encode("utf-8"))
        assert text == "a — b"

    def test_passthrough_replaces_invalid_bytes(self):
        # Doesn't raise on genuinely invalid bytes; degrades gracefully.
        assert _passthrough(b"ok \xff done")  # returns something, no exception


class TestMarkitdownFallback:
    def test_utf8_fallback_when_converter_raises(self, monkeypatch):
        """When markitdown's converter raises but the bytes are valid UTF-8,
        we recover them as plain text rather than dropping the source."""

        class _Boom:
            def convert(self, path):  # noqa: ARG002
                raise RuntimeError("PlainTextConverter threw UnicodeDecodeError")

        import markitdown

        monkeypatch.setattr(markitdown, "MarkItDown", lambda *a, **k: _Boom())
        out = _markitdown_convert("weird.rst", "café — résumé".encode("utf-8"))
        assert out == "café — résumé"

    def test_binary_reraises_original_error(self, monkeypatch):
        """Invalid-UTF-8 (real binary) re-raises the conversion error instead
        of masking it with garbage."""

        class _Boom:
            def convert(self, path):  # noqa: ARG002
                raise RuntimeError("real conversion failure")

        import markitdown

        monkeypatch.setattr(markitdown, "MarkItDown", lambda *a, **k: _Boom())
        try:
            _markitdown_convert("scan.pdf", b"%PDF\xff\xfe\x00binary")
        except RuntimeError as e:
            assert "real conversion failure" in str(e)
        else:
            raise AssertionError("expected RuntimeError to propagate")


class TestNormalizeStage:
    def test_rst_with_non_ascii_normalizes_cleanly(self):
        src = AcquiredSource(sha256="s1", name="docs/config.rst", data="Config — options".encode("utf-8"))
        out: list = []
        events = list(normalize([src], out))
        assert not any(e.kind == WikiEventKind.ERROR for e in events)
        assert len(out) == 1
        assert "Config — options" in out[0].markdown
