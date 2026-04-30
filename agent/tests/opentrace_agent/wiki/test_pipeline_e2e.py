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

"""End-to-end pipeline tests with a fake LLM and real on-disk vault."""

from __future__ import annotations

import hashlib
from pathlib import Path

from opentrace_agent.wiki import SourceInput, run_compile
from opentrace_agent.wiki.ingest.types import WikiEventKind, WikiPhase
from opentrace_agent.wiki.vault import load_metadata


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _source_summary_response(filename: str, body: str = "summary body") -> tuple[str, dict]:
    """Helper: scripted source-summary response keyed off the filename's title."""
    return (
        "emit_page",
        {
            "markdown_body": f"# Source Summary: {filename}\n\n{body}\n",
            "one_line_summary": f"Summary of {filename}.",
        },
    )


def test_first_compile_creates_pages(tmp_path: Path, fake_llm):
    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")

    source_summary = _source_summary_response("Ducks")
    plan_response = (
        "propose_plan",
        {
            "creates": [
                {
                    "title": "Ducks",
                    "source_shas": [_sha(src.data)],
                    "rationale": "fresh concept",
                }
            ],
            "extends": [],
        },
    )
    concept_response = (
        "emit_page",
        {
            "markdown_body": "# Ducks\n\nDucks are waterfowl. See [[Geese]].\n",
            "one_line_summary": "Ducks are waterfowl.",
        },
    )
    llm = fake_llm([source_summary, plan_response, concept_response])

    events = list(run_compile("testvault", [src], vault_root=tmp_path, llm=llm))

    kinds = [(e.phase, e.kind) for e in events]
    assert (WikiPhase.ACQUIRING, WikiEventKind.STAGE_START) in kinds
    assert (WikiPhase.SUMMARIZING_SOURCES, WikiEventKind.STAGE_START) in kinds
    assert (WikiPhase.PERSISTING, WikiEventKind.STAGE_STOP) in kinds
    assert events[-1].kind == WikiEventKind.DONE

    page = (tmp_path / "testvault" / "pages" / "ducks.md").read_text()
    assert page.startswith("# Ducks")
    assert "[[Geese]]" in page

    meta = load_metadata(tmp_path / "testvault" / ".vault.json", name="testvault")
    assert "ducks" in meta.pages
    assert meta.pages["ducks"].kind == "concept"
    # Source-summary page should be persisted alongside the concept page.
    assert "source-summary-ducks" in meta.pages
    assert meta.pages["source-summary-ducks"].kind == "source_summary"
    assert meta.pages["ducks"].one_line_summary == "Ducks are waterfowl."
    assert _sha(src.data) in meta.sources


def test_second_compile_with_same_source_is_idempotent(tmp_path: Path, fake_llm):
    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")

    llm1 = fake_llm(
        [
            _source_summary_response("Ducks"),
            (
                "propose_plan",
                {
                    "creates": [{"title": "Ducks", "source_shas": [_sha(src.data)]}],
                    "extends": [],
                },
            ),
            (
                "emit_page",
                {"markdown_body": "# Ducks\n\nDucks.\n", "one_line_summary": "About ducks."},
            ),
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm1))

    # Second call: SAME source, no scripted LLM responses — must not reach the LLM.
    llm2 = fake_llm([])
    events = list(run_compile("v", [src], vault_root=tmp_path, llm=llm2))
    assert events[-1].kind == WikiEventKind.DONE
    assert "vault unchanged" in events[-1].message
    assert llm2.calls == []


def test_extend_path_updates_existing_page(tmp_path: Path, fake_llm):
    src1 = SourceInput(name="a.md", data=b"# Ducks\nDucks are waterfowl.")
    src2 = SourceInput(name="b.md", data=b"# More ducks\nMallards are common.")

    create_only = fake_llm(
        [
            _source_summary_response("A"),
            (
                "propose_plan",
                {
                    "creates": [{"title": "Ducks", "source_shas": [_sha(src1.data)]}],
                    "extends": [],
                },
            ),
            (
                "emit_page",
                {"markdown_body": "# Ducks\n\nDucks are waterfowl.\n", "one_line_summary": "v1"},
            ),
        ]
    )
    list(run_compile("v", [src1], vault_root=tmp_path, llm=create_only))

    extend = fake_llm(
        [
            _source_summary_response("B"),
            (
                "propose_plan",
                {
                    "creates": [],
                    "extends": [{"page_slug": "ducks", "source_shas": [_sha(src2.data)]}],
                },
            ),
            (
                "emit_page",
                {
                    "markdown_body": "# Ducks\n\nDucks are waterfowl. Mallards are common.\n",
                    "one_line_summary": "v2",
                },
            ),
        ]
    )
    list(run_compile("v", [src2], vault_root=tmp_path, llm=extend))

    page = (tmp_path / "v" / "pages" / "ducks.md").read_text()
    assert "Mallards" in page
    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert meta.pages["ducks"].revision == 2
    assert _sha(src1.data) in meta.pages["ducks"].source_shas
    assert _sha(src2.data) in meta.pages["ducks"].source_shas


def test_fresh_vault_execute_sees_sibling_creates_as_neighbours(tmp_path: Path, fake_llm):
    """Each Execute-create call should be told about other planned creates,
    so a fresh-vault batch can produce inter-page wiki-links instead of
    every page having an empty neighbour list."""
    src = SourceInput(name="bundle.md", data=b"# Bundle\nFoo and Bar.")

    source_summary = _source_summary_response("Bundle")
    plan = (
        "propose_plan",
        {
            "creates": [
                {"title": "Foo", "source_shas": [_sha(src.data)]},
                {"title": "Bar", "source_shas": [_sha(src.data)]},
            ],
            "extends": [],
        },
    )
    foo_page = (
        "emit_page",
        {"markdown_body": "# Foo\n\nA thing.\n", "one_line_summary": "Foo."},
    )
    bar_page = (
        "emit_page",
        {"markdown_body": "# Bar\n\nA thing.\n", "one_line_summary": "Bar."},
    )
    llm = fake_llm([source_summary, plan, foo_page, bar_page])

    list(run_compile("v", [src], vault_root=tmp_path, llm=llm))

    # Calls: #1 source-summary, #2 plan, #3 Foo create, #4 Bar create.
    # Each Execute-create user message should mention the OTHER planned
    # create as a neighbour, plus the just-created Source Summary page.
    assert len(llm.calls) == 4
    _, foo_user_msg = llm.calls[2]
    _, bar_user_msg = llm.calls[3]
    assert "Bar" in foo_user_msg
    assert "Foo" in bar_user_msg
    assert "Source Summary: Bundle" in foo_user_msg
    assert "Source Summary: Bundle" in bar_user_msg
    assert "(no neighbour pages)" not in foo_user_msg
    assert "(no neighbour pages)" not in bar_user_msg


def test_source_summaries_emitted_one_per_new_source(tmp_path: Path, fake_llm):
    """Two new sources → two source-summary pages, plus whatever Plan creates."""
    src_a = SourceInput(name="alpha.md", data=b"# Alpha\nText A.")
    src_b = SourceInput(name="beta.md", data=b"# Beta\nText B.")
    llm = fake_llm(
        [
            _source_summary_response("Alpha", body="alpha-body"),
            _source_summary_response("Beta", body="beta-body"),
            ("propose_plan", {"creates": [], "extends": []}),
        ]
    )
    list(run_compile("v", [src_a, src_b], vault_root=tmp_path, llm=llm))
    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    summaries = {s for s, p in meta.pages.items() if p.kind == "source_summary"}
    assert summaries == {"source-summary-alpha", "source-summary-beta"}
    assert (tmp_path / "v" / "pages" / "source-summary-alpha.md").exists()
    assert (tmp_path / "v" / "pages" / "source-summary-beta.md").exists()


def test_plan_uses_source_summary_body(tmp_path: Path, fake_llm):
    """The Plan user message should contain the source-summary body and a
    'Salient terms from raw text' block, not raw markitdown."""
    src = SourceInput(
        name="ducks.md",
        data=(b"# Ducks\n\nMallards live in **wetlands**. The DUCK-1 species is well-studied.\n"),
    )
    llm = fake_llm(
        [
            _source_summary_response("Ducks", body="DISTINCTIVE_BODY_TEXT"),
            ("propose_plan", {"creates": [], "extends": []}),
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm))

    # Plan call is index 1 (after the source-summary call).
    _, plan_user_msg = llm.calls[1]
    # Source-summary body content reaches Plan.
    assert "DISTINCTIVE_BODY_TEXT" in plan_user_msg
    # The salient-terms block is appended for cross-source long-tail signal.
    assert "Salient terms from raw text:" in plan_user_msg
    assert "DUCK-1" in plan_user_msg  # acronym extracted from raw markdown
    # Per-source raw-markdown excerpt format is NOT present.
    assert "--- source: ducks.md" not in plan_user_msg


def test_compile_log_records_diff(tmp_path: Path, fake_llm):
    src = SourceInput(name="a.md", data=b"# A\nText.")
    llm = fake_llm(
        [
            _source_summary_response("A"),
            (
                "propose_plan",
                {"creates": [{"title": "A", "source_shas": [_sha(src.data)]}], "extends": []},
            ),
            ("emit_page", {"markdown_body": "# A\n\nBody.", "one_line_summary": "s"}),
        ]
    )
    list(run_compile("vlog", [src], vault_root=tmp_path, llm=llm))
    log_dir = tmp_path / "vlog" / ".compile-log"
    assert log_dir.is_dir()
    entries = list(log_dir.glob("*.json"))
    assert len(entries) == 1
    import json

    data = json.loads(entries[0].read_text())
    slugs = {p["slug"] for p in data["pages"]}
    assert "a" in slugs and "source-summary-a" in slugs
    concept = next(p for p in data["pages"] if p["slug"] == "a")
    assert concept["after_chars"] > 0
