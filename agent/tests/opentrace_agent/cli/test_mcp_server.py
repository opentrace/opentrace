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

"""Tests for mcp_server helpers."""

from __future__ import annotations

import json

from opentrace_agent.cli.mcp_server import (
    _DEFAULT_INDEX_TIMEOUT,
    NO_INDEX_MSG,
    _resolve_index_timeout,
    create_mcp_server,
)


def test_default_timeout_when_unset(monkeypatch: object) -> None:
    monkeypatch.delenv("OPENTRACE_INDEX_TIMEOUT", raising=False)
    assert _resolve_index_timeout() == _DEFAULT_INDEX_TIMEOUT


def test_explicit_timeout_honored(monkeypatch: object) -> None:
    monkeypatch.setenv("OPENTRACE_INDEX_TIMEOUT", "120")
    assert _resolve_index_timeout() == 120


def test_zero_means_no_timeout(monkeypatch: object) -> None:
    monkeypatch.setenv("OPENTRACE_INDEX_TIMEOUT", "0")
    assert _resolve_index_timeout() is None


def test_negative_means_no_timeout(monkeypatch: object) -> None:
    monkeypatch.setenv("OPENTRACE_INDEX_TIMEOUT", "-1")
    assert _resolve_index_timeout() is None


def test_garbage_falls_back_to_default(monkeypatch: object) -> None:
    monkeypatch.setenv("OPENTRACE_INDEX_TIMEOUT", "not-a-number")
    assert _resolve_index_timeout() == _DEFAULT_INDEX_TIMEOUT


def test_blank_falls_back_to_default(monkeypatch: object) -> None:
    monkeypatch.setenv("OPENTRACE_INDEX_TIMEOUT", "   ")
    assert _resolve_index_timeout() == _DEFAULT_INDEX_TIMEOUT


# ---------------------------------------------------------------------------
# fts_search tool: NO_INDEX, limit clamping, and argument forwarding.
# These exercise the tool wrapper without a real database — a fake store
# records what the tool passes through to GraphStore.fts_search.
# ---------------------------------------------------------------------------


def _fts_search_fn(store):
    """Extract the registered ``fts_search`` tool callable."""
    server = create_mcp_server(store)
    return server._tool_manager._tools["fts_search"].fn


class _RecordingStore:
    """Minimal store stub that records the kwargs fts_search forwards."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def fts_search(self, query, *, node_types=None, repo_id=None, limit=20):
        self.calls.append({"query": query, "node_types": node_types, "repo_id": repo_id, "limit": limit})
        return []


def test_fts_search_no_index_returns_friendly_message() -> None:
    fn = _fts_search_fn(None)
    assert fn(query="anything") == NO_INDEX_MSG


def test_fts_search_clamps_high_limit() -> None:
    store = _RecordingStore()
    _fts_search_fn(store)(query="q", limit=99999)
    assert store.calls[0]["limit"] == 1000


def test_fts_search_clamps_low_limit() -> None:
    store = _RecordingStore()
    _fts_search_fn(store)(query="q", limit=0)
    assert store.calls[0]["limit"] == 1


def test_fts_search_parses_node_types_csv() -> None:
    store = _RecordingStore()
    _fts_search_fn(store)(query="q", nodeTypes="Function, Class ,, ")
    assert store.calls[0]["node_types"] == ["Function", "Class"]


def test_fts_search_empty_node_types_is_none() -> None:
    store = _RecordingStore()
    _fts_search_fn(store)(query="q", nodeTypes="")
    assert store.calls[0]["node_types"] is None


def test_fts_search_strips_repo_and_blank_is_none() -> None:
    store = _RecordingStore()
    _fts_search_fn(store)(query="q", repo="  acme/widget  ")
    assert store.calls[0]["repo_id"] == "acme/widget"
    _fts_search_fn(store)(query="q", repo="   ")
    assert store.calls[1]["repo_id"] is None


def test_fts_search_returns_json_list() -> None:
    out = _fts_search_fn(_RecordingStore())(query="q")
    assert json.loads(out) == []


def test_fts_search_routes_errors_through_error_response() -> None:
    class _BoomStore:
        def fts_search(self, *args, **kwargs):
            raise RuntimeError("kaboom")

    out = _fts_search_fn(_BoomStore())(query="q")
    # Errors come back as a JSON object, never raised to the caller.
    parsed = json.loads(out)
    assert isinstance(parsed, dict)
