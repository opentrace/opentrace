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

"""Test fixtures for the wiki package."""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest


@pytest.fixture
def vault_root(tmp_path: Path) -> Path:
    return tmp_path / "vaults"


class FakeLLM:
    """Scriptable fake. Constructed with a list of {tool_name → response} dicts.

    Each ``call_tool`` invocation pops the next response. If ``tool_name``
    doesn't match the next scripted response's tool, the test fails loudly.

    Thread-safe: the summarise/execute stages now call ``call_tool``
    concurrently, so the pop + bookkeeping are guarded by a lock. Note that
    *which* response a given concurrent call receives is still pop-order, so
    tests that script several same-tool responses and assert per-call content
    should pin ``OT_WIKI_CONCURRENCY=1`` or assert order-independently.
    """

    def __init__(self, scripted: list[tuple[str, dict[str, Any]]]):
        self.scripted = list(scripted)
        self.calls: list[tuple[str, str]] = []
        self._lock = threading.Lock()

    def call_tool(
        self,
        *,
        system: str,
        user: str,
        tool_name: str,
        tool_schema: dict[str, Any],
        max_tokens: int = 4096,
    ) -> dict[str, Any]:
        with self._lock:
            if not self.scripted:
                raise AssertionError(f"FakeLLM called for {tool_name!r} but no responses left")
            expected_name, response = self.scripted.pop(0)
            if expected_name != tool_name:
                raise AssertionError(f"FakeLLM expected next call for {expected_name!r}, got {tool_name!r}")
            self.calls.append((tool_name, user))
            return response


@pytest.fixture
def fake_llm() -> Callable[[list[tuple[str, dict[str, Any]]]], FakeLLM]:
    return FakeLLM
