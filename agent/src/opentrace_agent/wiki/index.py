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

"""Vault index — a compact view of pages used as Plan-prompt input."""

from __future__ import annotations

from dataclasses import dataclass

from opentrace_agent.wiki.vault import VaultMetadata


@dataclass(frozen=True)
class IndexEntry:
    slug: str
    title: str
    one_line_summary: str


def build_index(meta: VaultMetadata) -> list[IndexEntry]:
    """Return a stable-ordered index for the vault."""
    entries = [IndexEntry(slug=p.slug, title=p.title, one_line_summary=p.one_line_summary) for p in meta.pages.values()]
    entries.sort(key=lambda e: (e.title.lower(), e.slug))
    return entries


def estimate_tokens(entries: list[IndexEntry]) -> int:
    """Rough token estimate (characters / 4) for the rendered index."""
    chars = 0
    for e in entries:
        chars += len(e.slug) + len(e.title) + len(e.one_line_summary) + 16
    return chars // 4
