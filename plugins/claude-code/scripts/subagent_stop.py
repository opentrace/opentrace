#!/usr/bin/env python3
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

"""SubagentStop hook: warn when a delegated OpenTrace subagent finished
without calling any `mcp__opentrace_oss__*` tool.

If `@dependency-analyzer`, `@find-usages`, or `@explain-service` returns
without touching the graph, the answer is almost certainly less complete
than a graph-backed one would have been — so we surface a heads-up to
the parent context.

Payload notes (per the Claude Code hooks reference):
- The subagent's name arrives in `agent_type`, possibly namespaced by
  plugin (e.g. ``opentrace-oss:dependency-analyzer``).
- `transcript_path` points at the PARENT session transcript. The
  subagent's own transcript lives next to it at
  ``<dir>/<session>/subagents/agent-<agent_id>.jsonl`` — scanning the
  parent would false-positive whenever the main session used the graph.

Fails closed on any read error (missing transcript, unparseable JSON).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from _common import emit_json, find_workspace_root, opentrace_healthy, read_event
from _debug import DebugLogger

_debug = DebugLogger("subagent-stop")

# Subagents shipped by this plugin. Generic subagents are out of scope —
# they aren't expected to use the graph.
_OPENTRACE_AGENTS = frozenset({
    "dependency-analyzer",
    "find-usages",
    "explain-service",
})

_GRAPH_TOOL_PREFIX = "mcp__opentrace_oss__"


def _agent_name(event: dict) -> str:
    """Extract the subagent name from `agent_type`, dropping any
    `plugin-name:` namespace prefix (plugin agents arrive namespaced,
    e.g. ``opentrace-oss:find-usages``).
    """
    raw = event.get("agent_type")
    if not isinstance(raw, str):
        return ""
    return raw.strip().rsplit(":", 1)[-1]


def _subagent_transcript(transcript_path: str, agent_id: str) -> Optional[Path]:
    """Resolve the subagent's own transcript from the parent transcript
    path and the subagent's `agent_id`.

    Layout: ``<dir>/<session>.jsonl`` (parent, what the event carries) →
    ``<dir>/<session>/subagents/agent-<agent_id>.jsonl`` (subagent).
    Returns None when it can't be found — callers must fail closed rather
    than fall back to the parent transcript.
    """
    if not transcript_path or not agent_id:
        return None
    parent = Path(transcript_path)
    candidate = parent.parent / parent.stem / "subagents" / f"agent-{agent_id}.jsonl"
    if candidate.is_file():
        return candidate
    # Some harnesses hand the subagent transcript directly; accept it
    # only when the filename unambiguously matches this agent.
    if parent.name == f"agent-{agent_id}.jsonl" and parent.is_file():
        return parent
    return None


def _iter_transcript(path: Path):
    """Yield each JSON event from a Claude Code transcript file.

    The transcript is JSONL — one event per line. Returns empty on any
    read/parse failure so this hook never blocks the model.
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def _used_graph_tool(transcript_path: Path) -> bool:
    """Return True if any tool_use in the transcript names an OpenTrace MCP tool."""
    for event in _iter_transcript(transcript_path):
        msg = event.get("message") or {}
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and isinstance(block.get("name"), str):
                if block["name"].startswith(_GRAPH_TOOL_PREFIX):
                    return True
    return False


def main() -> None:
    event = read_event()
    cwd = event.get("cwd")
    _debug.set_cwd(cwd or "")
    workspace_root = find_workspace_root(cwd)
    if not workspace_root or not opentrace_healthy(workspace_root):
        _debug("skip — opentrace not healthy")
        return

    agent_name = _agent_name(event)
    if agent_name not in _OPENTRACE_AGENTS:
        _debug(f"skip — non-opentrace agent: {agent_name!r}")
        return

    agent_id = event.get("agent_id")
    transcript_path = event.get("transcript_path") or ""
    transcript = _subagent_transcript(
        transcript_path, agent_id if isinstance(agent_id, str) else ""
    )
    if transcript is None:
        _debug(f"skip — no subagent transcript (agent_id={agent_id!r})")
        return

    if _used_graph_tool(transcript):
        _debug(f"clean — {agent_name} used graph tools")
        return

    msg = (
        f"OpenTrace: subagent `@{agent_name}` completed without calling any "
        "graph tool (`mcp__opentrace_oss__*`). Its answer is likely less "
        "complete than a graph-backed one — consider re-running with an "
        "explicit instruction to use the graph, or query the graph directly."
    )
    _debug(f"warning — {agent_name} did not use graph")
    emit_json({"systemMessage": msg})


if __name__ == "__main__":
    main()