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

from opentrace_agent.wiki.slugify import (
    base_slug,
    kind_dir,
    title_to_link_slug,
    unique_slug,
)


def test_base_slug_lowercases_and_dashes():
    assert base_slug("Hello World") == "hello-world"


def test_base_slug_ascii_folds():
    assert base_slug("Café Société") == "cafe-societe"


def test_base_slug_strips_punctuation():
    assert base_slug("LLM Wiki — v1!") == "llm-wiki-v1"


def test_base_slug_empty_input():
    assert base_slug("") == "untitled"
    assert base_slug("!!!") == "untitled"


def test_kind_dir_maps_concept_and_file_summary():
    assert kind_dir("concept") == "concept"
    assert kind_dir("file_summary") == "file-summary"


def test_kind_dir_falls_back_to_concept_for_unknown():
    assert kind_dir("source") == "concept"
    assert kind_dir("") == "concept"


def test_unique_slug_concept_no_collision():
    assert unique_slug("Foo", existing=set()) == "concept/foo"


def test_unique_slug_file_summary_lands_under_file_summary_dir():
    assert unique_slug("Foo", kind="file_summary", existing=set()) == "file-summary/foo"


def test_unique_slug_same_title_across_kinds_does_not_collide():
    # The kind directory IS the namespace — both pages can share a base.
    concept = unique_slug("Usage", kind="concept", existing={"file-summary/usage"})
    summary = unique_slug("Usage", kind="file_summary", existing={"concept/usage"})
    assert concept == "concept/usage"
    assert summary == "file-summary/usage"


def test_unique_slug_appends_suffix_on_collision_within_kind():
    assert unique_slug("Foo", existing={"concept/foo"}) == "concept/foo-2"
    assert unique_slug("Foo", existing={"concept/foo", "concept/foo-2"}) == "concept/foo-3"


def test_tombstones_block_reuse():
    assert unique_slug("Foo", existing=set(), tombstones={"concept/foo"}) == "concept/foo-2"


def test_title_to_link_slug_does_not_apply_collision_suffix():
    # The renderer maps title → base slug under its kind folder; collisions
    # surface as broken links by design.
    assert title_to_link_slug("Foo") == "concept/foo"
    assert title_to_link_slug("Foo", kind="file_summary") == "file-summary/foo"
