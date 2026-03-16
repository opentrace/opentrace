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

"""Cross-validation: verify Python extractor output matches shared expected fixtures.

Each fixture pair (.txt source + .expected.json output) defines the contract
that both the Python agent and TS UI extractors must satisfy.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from opentrace_agent.sources.code.extractors.base import CodeSymbol
from opentrace_agent.sources.code.extractors.typescript_extractor import TypeScriptExtractor

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "cross-validation"

FIXTURES = [p.stem for p in sorted(FIXTURE_DIR.glob("*.txt"))]


def _symbol_to_dict(sym: CodeSymbol) -> dict:
    """Normalize a CodeSymbol to a JSON-compatible dict for comparison."""
    return {
        "name": sym.name,
        "kind": sym.kind,
        "start_line": sym.start_line,
        "end_line": sym.end_line,
        "signature": sym.signature,
        "children": [_symbol_to_dict(c) for c in sym.children],
        "calls": [
            {"name": c.name, "receiver": c.receiver, "kind": c.kind}
            for c in sym.calls
        ],
    }


@pytest.fixture(scope="module")
def extractor() -> TypeScriptExtractor:
    return TypeScriptExtractor()


@pytest.mark.parametrize("fixture_name", FIXTURES, ids=FIXTURES)
def test_python_matches_expected(fixture_name: str, extractor: TypeScriptExtractor) -> None:
    source_path = FIXTURE_DIR / f"{fixture_name}.txt"
    expected_path = FIXTURE_DIR / f"{fixture_name}.expected.json"

    source_bytes = source_path.read_bytes()
    expected = json.loads(expected_path.read_text())

    result = extractor.extract(source_bytes)
    actual = [_symbol_to_dict(s) for s in result.symbols]

    assert actual == expected, (
        f"Python extractor output for '{fixture_name}' does not match expected.\n"
        f"Actual:\n{json.dumps(actual, indent=2)}\n"
        f"Expected:\n{json.dumps(expected, indent=2)}"
    )
