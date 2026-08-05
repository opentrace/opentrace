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

"""Tests for ``base_slug`` — the vault-naming slugifier.

The page-slug helpers this module also held (``kind_dir``, ``unique_slug``,
``title_to_link_slug``) went with the concept-page layer on 2026-08-04.
"""

from opentrace_agent.wiki.slugify import base_slug


def test_base_slug_lowercases_and_dashes():
    assert base_slug("Hello World") == "hello-world"


def test_base_slug_ascii_folds():
    assert base_slug("Café Société") == "cafe-societe"


def test_base_slug_strips_punctuation():
    assert base_slug("LLM Wiki — v1!") == "llm-wiki-v1"


def test_base_slug_empty_input():
    assert base_slug("") == "untitled"
    assert base_slug("!!!") == "untitled"


def test_base_slug_truncates_and_trims_trailing_dash():
    from opentrace_agent.wiki.slugify import MAX_SLUG_LEN

    out = base_slug("word " * 40)
    assert len(out) <= MAX_SLUG_LEN
    assert not out.endswith("-")
