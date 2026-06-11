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

from opentrace_agent.wiki.ingest.extract import extract_salient_terms


def test_extracts_headings_at_all_levels():
    md = "# Top\n\n## Mid section\n\n### Deeper Heading\n\nbody"
    out = extract_salient_terms(md)
    assert "Top" in out
    assert "Mid section" in out
    assert "Deeper Heading" in out


def test_extracts_acronyms_with_digits_and_hyphens():
    md = "HACCP defines CCP-1, CCP-2, CCP-3. Audit at DC-7. SOP-CC-2026 supersedes RFP-V1."
    out = extract_salient_terms(md)
    for term in ("HACCP", "CCP-1", "CCP-2", "CCP-3", "DC-7", "SOP-CC-2026", "RFP-V1"):
        assert term in out, f"missing acronym: {term}"


def test_extracts_multi_word_proper_nouns():
    md = "Priya Rao approved the Cold Chain plan. Midwest Beef Co submitted an RFP."
    out = extract_salient_terms(md)
    assert "Priya Rao" in out
    assert "Cold Chain" in out
    assert "Midwest Beef Co" in out


def test_extracts_bold_and_italic_spans():
    md = "The **TempGuard** sensor logs every *critical* event. __ChainSight__ is _enabled_."
    out = extract_salient_terms(md)
    assert "TempGuard" in out
    assert "critical" in out
    assert "ChainSight" in out
    assert "enabled" in out


def test_extracts_numbers_with_units():
    md = "Frozen storage at -18°C. Alert after 10 min. Total area is 412,000 sq ft. Capacity 1840 pallets."
    out = extract_salient_terms(md)
    assert "-18°C" in out
    assert "10 min" in out
    assert any("412,000" in term for term in out)
    assert any("1840 pallets" in term for term in out)


def test_dedupes_repeated_terms():
    md = "HACCP HACCP HACCP\n\n# Cold Chain\n\nCold Chain Cold Chain"
    out = extract_salient_terms(md)
    assert out.count("HACCP") == 1
    assert out.count("Cold Chain") == 1


def test_sorts_output_alphabetically():
    md = "Zulu HACCP Alpha\n\n# Beta\n\nDC-7"
    out = extract_salient_terms(md)
    # Check that the order is sorted (caller can rely on this).
    assert out == sorted(out)


def test_handles_empty_input():
    assert extract_salient_terms("") == []


def test_does_not_match_single_capital_letters_as_acronyms():
    """A single capital like 'I' or sentence-start 'The' shouldn't pollute the list."""
    md = "The system runs. A new alert fires."
    out = extract_salient_terms(md)
    # Single letters / common single-cap starts shouldn't appear as acronyms.
    assert "T" not in out
    assert "A" not in out
