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

from opentrace_agent.wiki.slugify import base_slug, title_to_link_slug, unique_slug


def test_base_slug_lowercases_and_dashes():
    assert base_slug("Hello World") == "hello-world"


def test_base_slug_ascii_folds():
    assert base_slug("Café Société") == "cafe-societe"


def test_base_slug_strips_punctuation():
    assert base_slug("LLM Wiki — v1!") == "llm-wiki-v1"


def test_base_slug_empty_input():
    assert base_slug("") == "untitled"
    assert base_slug("!!!") == "untitled"


def test_unique_slug_with_no_collision():
    assert unique_slug("Foo", existing=set()) == "foo"


def test_unique_slug_appends_suffix_on_collision():
    assert unique_slug("Foo", existing={"foo"}) == "foo-2"
    assert unique_slug("Foo", existing={"foo", "foo-2"}) == "foo-3"


def test_tombstones_block_reuse():
    assert unique_slug("Foo", existing=set(), tombstones={"foo"}) == "foo-2"


def test_title_to_link_slug_does_not_apply_collision_suffix():
    # The renderer maps title→base slug; collisions surface as broken links by design.
    assert title_to_link_slug("Foo") == "foo"
