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

"""Tests for ``entity_node_type`` — the type-normaliser used to title-case
LLM-emitted entity types and fall back to ``Idea`` for anything outside
the valid set.

Used by ``pipeline/entity_extraction`` to map raw LLM type strings into
the small set of stable node types the store accepts.
"""

from __future__ import annotations

import pytest

from opentrace_agent.sources.markdown.extractor import (
    VALID_LLM_ENTITY_TYPES,
    entity_node_type,
)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("idea", "Idea"),
        ("service", "Service"),
        ("paper", "Paper"),
        ("person", "Person"),
        ("event", "Event"),
        ("module", "Module"),
        # Unknown types fall back to Idea rather than leaking into the store.
        ("widget", "Idea"),
        ("", "Idea"),
    ],
)
def test_normalises(raw, expected):
    assert entity_node_type(raw) == expected


def test_valid_set_is_the_canonical_idea_plus_concrete_types():
    assert VALID_LLM_ENTITY_TYPES == frozenset({"Idea", "Service", "Module", "Paper", "Person", "Event"})
