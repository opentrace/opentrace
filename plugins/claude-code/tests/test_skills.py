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

"""Static validation of every SKILL.md, agent .md, and command .md
frontmatter shipped by the plugin. Catches the most common breakage
modes that prevent Claude Code from loading them at all:

- Missing or malformed YAML frontmatter
- Required fields absent
- Skill ``name:`` not matching its directory name
- Tools list referencing MCP namespaces this plugin doesn't expose
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = PLUGIN_ROOT / "skills"
AGENTS_DIR = PLUGIN_ROOT / "agents"
COMMANDS_DIR = PLUGIN_ROOT / "commands"

# MCP server name from .mcp.json — used to validate tool references.
MCP_NAMESPACE = "mcp__opentrace_oss__"

# Known builtins that agents/skills are allowed to declare.
BUILTIN_TOOLS = frozenset(
    {"Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task"}
)

EXPECTED_SKILLS = {
    "opentrace-explore",
    "opentrace-find-usages",
    "opentrace-graph-status",
    "opentrace-impact",
    "opentrace-index",
    "opentrace-interrogate",
    "opentrace-update",
    "opentrace-diagram",
    "opentrace-dead-code",
    "opentrace-refactor-plan",
    "opentrace-onboarding-tour",
}

EXPECTED_AGENTS = {"dependency-analyzer", "find-usages", "explain-service"}

EXPECTED_COMMANDS = {"auth", "graph-status", "index", "update"}

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _parse_frontmatter(path: Path) -> dict:
    text = path.read_text()
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}
    return yaml.safe_load(match.group(1)) or {}


def _parse_tools_csv(value) -> list[str]:
    """``tools`` and ``allowed-tools`` are CSV strings in Claude Code."""
    if not value:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [t.strip() for t in str(value).split(",") if t.strip()]


# ---------------------------------------------------------------------------
# Skills
# ---------------------------------------------------------------------------

def test_skills_directory_matches_expected_set():
    on_disk = {p.name for p in SKILLS_DIR.iterdir() if p.is_dir()}
    assert on_disk == EXPECTED_SKILLS, (
        f"Skill dirs drifted from plan. Extra={on_disk - EXPECTED_SKILLS} "
        f"Missing={EXPECTED_SKILLS - on_disk}"
    )


@pytest.mark.parametrize("skill_dir", sorted(EXPECTED_SKILLS))
def test_skill_frontmatter_well_formed(skill_dir):
    path = SKILLS_DIR / skill_dir / "SKILL.md"
    assert path.is_file(), f"{path} missing"
    fm = _parse_frontmatter(path)
    assert fm, f"{path} has no YAML frontmatter"
    assert "name" in fm, f"{path} missing 'name'"
    assert fm["name"] == skill_dir, (
        f"{path} name={fm['name']!r} does not match dir {skill_dir!r}"
    )
    assert "description" in fm and fm["description"], (
        f"{path} missing 'description'"
    )
    assert "allowed-tools" in fm and fm["allowed-tools"], (
        f"{path} missing 'allowed-tools'"
    )


@pytest.mark.parametrize("skill_dir", sorted(EXPECTED_SKILLS))
def test_skill_allowed_tools_use_known_namespaces(skill_dir):
    path = SKILLS_DIR / skill_dir / "SKILL.md"
    fm = _parse_frontmatter(path)
    tools = _parse_tools_csv(fm.get("allowed-tools"))
    for tool in tools:
        if tool in BUILTIN_TOOLS:
            continue
        assert tool.startswith(MCP_NAMESPACE), (
            f"{path}: tool {tool!r} is neither a builtin nor a "
            f"{MCP_NAMESPACE}* MCP tool"
        )


def test_every_skill_description_invokes_preferred_framing():
    """Per the plugin's CLAUDE.md guidance, descriptions should lead with
    'PREFERRED' to win routing against shell tools.
    """
    missing = []
    for skill_dir in EXPECTED_SKILLS:
        fm = _parse_frontmatter(SKILLS_DIR / skill_dir / "SKILL.md")
        desc = (fm.get("description") or "").strip()
        if not desc.startswith("PREFERRED"):
            missing.append(skill_dir)
    assert not missing, f"Skills missing 'PREFERRED' lead: {missing}"


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------

def test_agents_directory_matches_expected_set():
    on_disk = {p.stem for p in AGENTS_DIR.glob("*.md")}
    assert on_disk == EXPECTED_AGENTS


@pytest.mark.parametrize("agent_name", sorted(EXPECTED_AGENTS))
def test_agent_frontmatter_well_formed(agent_name):
    path = AGENTS_DIR / f"{agent_name}.md"
    fm = _parse_frontmatter(path)
    assert fm["name"] == agent_name
    assert fm["description"]
    assert "tools" in fm and fm["tools"]
    # Phase 4: every agent should declare a model. Plugin-loaded subagents
    # may ignore it, but it shouldn't be silently absent.
    assert "model" in fm, f"{path} missing 'model' field (Phase 4)"
    assert fm["model"] in {"haiku", "sonnet", "opus", "inherit"}, (
        f"{path} model={fm['model']!r} should be a known alias"
    )


@pytest.mark.parametrize("agent_name", sorted(EXPECTED_AGENTS))
def test_agent_tools_use_known_namespaces(agent_name):
    fm = _parse_frontmatter(AGENTS_DIR / f"{agent_name}.md")
    for tool in _parse_tools_csv(fm.get("tools")):
        if tool in BUILTIN_TOOLS:
            continue
        assert tool.startswith(MCP_NAMESPACE), (
            f"agent {agent_name}: tool {tool!r} unknown"
        )


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def test_commands_directory_matches_expected_set():
    on_disk = {p.stem for p in COMMANDS_DIR.glob("*.md")}
    assert on_disk == EXPECTED_COMMANDS


@pytest.mark.parametrize("command_name", sorted(EXPECTED_COMMANDS))
def test_command_file_nonempty(command_name):
    path = COMMANDS_DIR / f"{command_name}.md"
    text = path.read_text().strip()
    assert text, f"{path} is empty"