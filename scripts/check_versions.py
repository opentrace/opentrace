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

"""Verify the three files that must share a version are in sync.

Per the Claude Code plugin's versioning contract:

    .claude-plugin/marketplace.json  → plugins[0].version
    plugins/claude-code/.claude-plugin/plugin.json → version
    agent/pyproject.toml             → project.version

The first two must match exactly (plugin + marketplace). The agent
version is bumped independently but should be flagged when it diverges
from the plugin so the contributor confirms it's intentional.

Exits 0 on success; non-zero with a diff-style report on failure.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

MARKETPLACE = REPO / ".claude-plugin" / "marketplace.json"
PLUGIN = REPO / "plugins" / "claude-code" / ".claude-plugin" / "plugin.json"
PYPROJECT = REPO / "agent" / "pyproject.toml"


def _read_marketplace_version() -> str:
    data = json.loads(MARKETPLACE.read_text())
    plugins = data.get("plugins") or []
    if not plugins:
        raise SystemExit(f"{MARKETPLACE}: no plugins[] entries")
    version = plugins[0].get("version")
    if not version:
        raise SystemExit(f"{MARKETPLACE}: plugins[0].version missing")
    return version


def _read_plugin_version() -> str:
    data = json.loads(PLUGIN.read_text())
    version = data.get("version")
    if not version:
        raise SystemExit(f"{PLUGIN}: version field missing")
    return version


_PYPROJECT_VERSION_RE = re.compile(
    r'^\s*version\s*=\s*["\']([^"\']+)["\']', re.MULTILINE
)


def _read_pyproject_version() -> str:
    text = PYPROJECT.read_text()
    # Confine the search to the [project] table so a tool-specific
    # version (e.g. [tool.something] version = "...") isn't picked up.
    project_block = re.search(
        r"\[project\][^\[]*", text, re.DOTALL
    )
    if not project_block:
        raise SystemExit(f"{PYPROJECT}: [project] table not found")
    match = _PYPROJECT_VERSION_RE.search(project_block.group(0))
    if not match:
        raise SystemExit(f"{PYPROJECT}: project.version not found")
    return match.group(1)


def main() -> int:
    marketplace_v = _read_marketplace_version()
    plugin_v = _read_plugin_version()
    agent_v = _read_pyproject_version()

    rows = [
        ("marketplace.json (plugins[0].version)", marketplace_v),
        ("plugin.json (version)", plugin_v),
        ("agent/pyproject.toml (project.version)", agent_v),
    ]

    print("Version sync check:")
    for label, v in rows:
        print(f"  {v:<10} {label}")

    if marketplace_v != plugin_v:
        print(
            f"\nERROR: marketplace.json ({marketplace_v}) and "
            f"plugin.json ({plugin_v}) must match exactly.",
            file=sys.stderr,
        )
        return 1

    if agent_v != plugin_v:
        # Soft warning — the agent can ship independently — but flag it so
        # the contributor confirms the divergence is intentional.
        print(
            f"\nWARNING: agent ({agent_v}) and plugin ({plugin_v}) versions "
            "differ. This is allowed for agent-only releases; ensure it's "
            "intentional.",
            file=sys.stderr,
        )

    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
