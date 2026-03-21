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

"""Agent functions for SWE-bench evaluation.

Two agent backends:

1. **API agent** (``create_agent_fn``) — calls the Anthropic API directly with
   tool_use.  Requires ``pip install opentraceai[swe-bench]`` and
   ``ANTHROPIC_API_KEY``.

2. **Claude Code agent** (``create_claude_code_agent_fn``) — shells out to the
   ``claude`` CLI in ``--print`` mode.  Claude Code already has Read, Edit,
   Bash, Grep, Glob, and (via plugin) the OpenTrace MCP tools.  No extra
   dependencies — just needs ``claude`` on ``$PATH``.

Usage::

    # API agent
    agent_fn = create_agent_fn(model="claude-sonnet-4-20250514")

    # Claude Code agent (recommended)
    agent_fn = create_claude_code_agent_fn(model="sonnet")
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tool definitions for Claude tool_use
# ---------------------------------------------------------------------------

OPENTRACE_TOOLS: list[dict[str, Any]] = [
    {
        "name": "search_graph",
        "description": (
            "Full-text search across graph nodes by name or properties. "
            "Returns matching nodes with their types and properties."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query string."},
                "limit": {"type": "integer", "description": "Max results (default 50).", "default": 50},
                "nodeTypes": {
                    "type": "string",
                    "description": "Comma-separated node types to filter (e.g. 'File', 'Class,Function').",
                    "default": "",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "list_nodes",
        "description": (
            "List nodes of a specific type. "
            "Valid types: Repository, Class, Function, File, Directory, Package, Module, Service, Endpoint, Database."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "description": "Node type to list."},
                "limit": {"type": "integer", "description": "Max results (default 50).", "default": 50},
            },
            "required": ["type"],
        },
    },
    {
        "name": "get_node",
        "description": "Get full details of a single node by its ID, including all properties and immediate neighbors.",
        "input_schema": {
            "type": "object",
            "properties": {
                "nodeId": {"type": "string", "description": "The node ID to look up."},
            },
            "required": ["nodeId"],
        },
    },
    {
        "name": "traverse_graph",
        "description": (
            "Walk relationships from a starting node. "
            "Direction: 'outgoing', 'incoming', or 'both'. "
            "Optionally filter by relationship type (e.g. 'CALLS', 'DEFINES', 'CONTAINS')."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "nodeId": {"type": "string", "description": "Starting node ID."},
                "depth": {"type": "integer", "description": "Max traversal depth (default 3, max 10).", "default": 3},
                "direction": {
                    "type": "string",
                    "enum": ["outgoing", "incoming", "both"],
                    "description": "Traversal direction.",
                    "default": "outgoing",
                },
                "relationship": {
                    "type": "string",
                    "description": "Filter by relationship type (empty = all).",
                    "default": "",
                },
            },
            "required": ["nodeId"],
        },
    },
    {
        "name": "get_stats",
        "description": "Get graph statistics: total node count, total edge count, and node counts by type.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "read_file",
        "description": "Read the contents of a file from the repository.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path within the repository (e.g. 'src/main.py').",
                },
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_directory",
        "description": "List files and directories at a path in the repository.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path within the repository (empty or '.' for root).",
                    "default": ".",
                },
            },
        },
    },
    {
        "name": "generate_patch",
        "description": (
            "When you have determined the fix, call this tool with the unified diff patch. "
            "This ends the session and submits the patch."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "patch": {
                    "type": "string",
                    "description": "The unified diff patch to apply.",
                },
            },
            "required": ["patch"],
        },
    },
]

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are a software engineering agent tasked with fixing bugs and implementing \
features in codebases. You will be given a problem statement describing an issue \
in a repository.

Your goal is to:
1. Understand the problem by reading the problem statement carefully.
2. Explore the codebase to find the relevant files and understand the code.
3. Determine the root cause and develop a fix.
4. Generate a unified diff patch that resolves the issue.

You have the following tools available:
- **read_file**: Read file contents from the repository.
- **list_directory**: List files/directories at a path.
- **generate_patch**: Submit your final unified diff patch.

{opentrace_section}

Strategy:
- Start by understanding the problem statement thoroughly.
- Use the codebase exploration tools to find relevant files.
- {graph_strategy}
- Read the specific files you need to understand.
- Make minimal, targeted changes — fix the bug without unnecessary refactoring.
- Generate a clean unified diff patch using generate_patch.

IMPORTANT: You MUST call generate_patch with your fix when you are done. \
Even if you're unsure, provide your best attempt at a patch.\
"""

OPENTRACE_SECTION = """\
Additionally, you have OpenTrace graph tools for understanding the codebase structure:
- **get_stats**: See what's indexed (node counts by type).
- **search_graph**: Find files, classes, functions by name.
- **list_nodes**: List all nodes of a type (File, Class, Function, etc.).
- **get_node**: Get details and neighbors (relationships) of a specific node.
- **traverse_graph**: Walk relationships (CALLS, DEFINED_IN, etc.) from a node.\
"""

GRAPH_STRATEGY = (
    "Use OpenTrace tools to quickly find relevant files and understand code structure before reading files."
)
NO_GRAPH_STRATEGY = "Use list_directory and read_file to explore the codebase."

MAX_TURNS = 30
MAX_OUTPUT_TOKENS = 4096


# ---------------------------------------------------------------------------
# Tool dispatcher
# ---------------------------------------------------------------------------


class ToolDispatcher:
    """Routes Claude tool calls to the appropriate handler."""

    def __init__(self, repo_path: Path, mcp_tools: dict[str, Any] | None = None) -> None:
        self._repo_path = repo_path.resolve()
        self._mcp_tools = mcp_tools  # MCP tool functions from GraphAccuracyBenchmark style
        self._patch: str | None = None

    @property
    def patch(self) -> str | None:
        return self._patch

    def dispatch(self, name: str, input_args: dict[str, Any]) -> str:
        """Execute a tool and return the result as a string."""
        try:
            if name == "read_file":
                return self._read_file(input_args["path"])
            elif name == "list_directory":
                return self._list_directory(input_args.get("path", "."))
            elif name == "generate_patch":
                self._patch = input_args["patch"]
                return "Patch submitted successfully."
            elif name in ("search_graph", "list_nodes", "get_node", "traverse_graph", "get_stats"):
                return self._call_mcp(name, input_args)
            else:
                return json.dumps({"error": f"Unknown tool: {name}"})
        except Exception as e:
            return json.dumps({"error": f"{type(e).__name__}: {e}"})

    def _read_file(self, rel_path: str) -> str:
        target = (self._repo_path / rel_path).resolve()
        # Security: prevent path traversal
        if not str(target).startswith(str(self._repo_path)):
            return json.dumps({"error": "Path traversal not allowed"})
        if not target.is_file():
            return json.dumps({"error": f"File not found: {rel_path}"})
        try:
            content = target.read_text(errors="replace")
            # Truncate very large files
            if len(content) > 50_000:
                content = content[:50_000] + "\n...[truncated at 50000 chars]"
            return content
        except Exception as e:
            return json.dumps({"error": f"Read error: {e}"})

    def _list_directory(self, rel_path: str) -> str:
        target = (self._repo_path / rel_path).resolve()
        if not str(target).startswith(str(self._repo_path)):
            return json.dumps({"error": "Path traversal not allowed"})
        if not target.is_dir():
            return json.dumps({"error": f"Directory not found: {rel_path}"})
        entries = []
        for child in sorted(target.iterdir()):
            if child.name.startswith("."):
                continue
            kind = "dir" if child.is_dir() else "file"
            entries.append({"name": child.name, "type": kind})
        return json.dumps(entries)

    def _call_mcp(self, name: str, args: dict[str, Any]) -> str:
        if self._mcp_tools is None:
            return json.dumps({"error": "OpenTrace tools not available (no index)"})
        tool = self._mcp_tools.get(name)
        if tool is None:
            return json.dumps({"error": f"MCP tool not found: {name}"})
        return tool.fn(**args)


# ---------------------------------------------------------------------------
# Agent function factory
# ---------------------------------------------------------------------------


def create_agent_fn(
    *,
    model: str = "claude-sonnet-4-20250514",
    max_turns: int = MAX_TURNS,
    max_tokens: int = MAX_OUTPUT_TOKENS,
    api_key: str | None = None,
) -> Any:
    """Create an :data:`AgentFn` that uses the Anthropic API.

    Parameters
    ----------
    model : str
        Claude model to use.
    max_turns : int
        Maximum conversation turns (tool-use rounds).
    max_tokens : int
        Max output tokens per API call.
    api_key : str or None
        Anthropic API key. Falls back to ``ANTHROPIC_API_KEY`` env var.
    """
    try:
        import anthropic
    except ImportError:
        raise ImportError(
            "The 'anthropic' package is required for the SWE-bench agent. Install it with: uv add anthropic"
        ) from None

    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise ValueError(
            "ANTHROPIC_API_KEY environment variable is required. Set it or pass api_key= to create_agent_fn()."
        )

    client = anthropic.Anthropic(api_key=key)

    def agent_fn(
        problem_statement: str,
        repo_path: Path,
        mcp_config: dict[str, Any] | None,
    ) -> str:
        """Solve a SWE-bench instance using Claude with optional OpenTrace tools."""
        # Build tool dispatcher
        mcp_tools = None
        if mcp_config and "db_path" in mcp_config:
            try:
                from opentrace_agent.cli.mcp_server import create_mcp_server
                from opentrace_agent.store import GraphStore

                store = GraphStore(mcp_config["db_path"], read_only=True)
                server = create_mcp_server(store)
                mcp_tools = server._tool_manager._tools
            except Exception as e:
                logger.warning("Failed to load OpenTrace tools: %s", e)

        dispatcher = ToolDispatcher(repo_path, mcp_tools)

        # Select tools and system prompt
        use_opentrace = mcp_tools is not None
        if use_opentrace:
            tools = OPENTRACE_TOOLS
            system = SYSTEM_PROMPT.format(
                opentrace_section=OPENTRACE_SECTION,
                graph_strategy=GRAPH_STRATEGY,
            )
        else:
            tools = [t for t in OPENTRACE_TOOLS if t["name"] in ("read_file", "list_directory", "generate_patch")]
            system = SYSTEM_PROMPT.format(
                opentrace_section="",
                graph_strategy=NO_GRAPH_STRATEGY,
            )

        messages: list[dict[str, Any]] = [
            {"role": "user", "content": f"Here is the problem to solve:\n\n{problem_statement}"},
        ]

        for turn in range(max_turns):
            logger.debug("Turn %d/%d (messages=%d)", turn + 1, max_turns, len(messages))

            response = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system,
                tools=tools,
                messages=messages,
            )

            # Check if we got tool calls
            tool_uses = [b for b in response.content if b.type == "tool_use"]
            text_blocks = [b for b in response.content if b.type == "text"]

            if text_blocks:
                for tb in text_blocks:
                    logger.debug("Claude: %s", tb.text[:200])

            if not tool_uses:
                # No tool calls — model is done (or stuck)
                if dispatcher.patch is not None:
                    return dispatcher.patch
                # Try to extract a patch from the text response
                for tb in text_blocks:
                    if "diff" in tb.text.lower() or "---" in tb.text:
                        return tb.text
                logger.warning("Agent finished without generating a patch")
                return ""

            # Process tool calls
            messages.append({"role": "assistant", "content": response.content})

            tool_results = []
            for tool_use in tool_uses:
                logger.debug("Tool call: %s(%s)", tool_use.name, json.dumps(tool_use.input)[:200])
                result = dispatcher.dispatch(tool_use.name, tool_use.input)
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": result[:20_000],  # Truncate very large results
                    }
                )

                # Early exit if patch was submitted
                if dispatcher.patch is not None:
                    return dispatcher.patch

            messages.append({"role": "user", "content": tool_results})

            if response.stop_reason == "end_turn":
                if dispatcher.patch is not None:
                    return dispatcher.patch
                break

        logger.warning("Agent hit max turns (%d) without submitting a patch", max_turns)
        return dispatcher.patch or ""

    return agent_fn


# ---------------------------------------------------------------------------
# Convenience: run from command line
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Claude Code agent — shells out to `claude` CLI
# ---------------------------------------------------------------------------

CLAUDE_CODE_PROMPT = """\
You are solving a coding task. Here is the problem:

{problem_statement}

The repository is at: {repo_path}

Instructions:
1. Read the problem statement carefully.
2. {explore_instruction}
3. Find the relevant files, understand the bug or feature request.
4. Edit the files to fix the issue. Make minimal, targeted changes.
5. When done, do NOT commit. Just leave the edited files in place.

IMPORTANT: Do not create new test files or modify tests unless the problem \
specifically asks for it. Focus on fixing the production code.\
"""

EXPLORE_WITH_OT = (
    "Use the OpenTrace MCP tools (search_nodes, get_neighbors, traverse_outgoing, etc.) "
    "to quickly find relevant files and understand code structure, then read and edit them."
)
EXPLORE_WITHOUT_OT = "Explore the codebase using Read, Grep, and Glob to find relevant files."


PLUGIN_DIR = Path(__file__).resolve().parents[4] / "claude-code-plugin"

# ANSI colors for trace output
_DIM = "\033[2m"
_CYAN = "\033[36m"
_GREEN = "\033[32m"
_RED = "\033[31m"
_RESET = "\033[0m"
_BOLD = "\033[1m"


def _run_claude_code_traced(args: list[str], cwd: str, prompt: str, out: Any) -> dict[str, Any]:
    """Run Claude Code with stream-json and parse events into a readable trace.

    Claude Code's stream-json emits NDJSON with these event types:
    - ``{"type": "system", "subtype": "init", "tools": [...], ...}``
    - ``{"type": "assistant", "message": {"content": [...]}, ...}``
      where content blocks are ``{"type": "tool_use", "name": ..., "input": ...}``
      or ``{"type": "text", "text": ...}``
    - ``{"type": "tool_result", "content": ..., ...}``
    - ``{"type": "result", "total_cost_usd": ..., "num_turns": ..., ...}``

    Returns a dict with ``num_turns``, ``cost_usd``, ``tool_calls`` extracted
    from the stream.
    """
    proc = subprocess.Popen(
        args,
        cwd=cwd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    proc.stdin.write(prompt)
    proc.stdin.close()

    tool_count = 0
    stats: dict[str, Any] = {"num_turns": 0, "cost_usd": 0.0, "tool_calls": 0}

    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        etype = event.get("type", "")

        if etype == "system" and event.get("subtype") == "init":
            model = event.get("model", "?")
            tools = event.get("tools", [])
            mcp = event.get("mcp_servers", [])
            connected = [s["name"] for s in mcp if s.get("status") == "connected"]
            failed = [f"{s['name']}({s.get('status')})" for s in mcp if s.get("status") != "connected"]
            ot_tools = [t for t in tools if "opentrace" in t.lower()]
            out.write(f"        {_DIM}init: model={model}, {len(tools)} tools")
            if connected:
                out.write(f", mcp=[{', '.join(connected)}]")
            if failed:
                out.write(f"\n        {_RED}  mcp failed: [{', '.join(failed)}]{_RESET}")
            if ot_tools:
                out.write(f"\n        {_GREEN}  opentrace tools: {ot_tools}{_RESET}")
            elif connected:
                out.write(f"\n        {_RED}  WARNING: no opentrace tools found in tool list{_RESET}")
            out.write(f"{_RESET}\n")
            out.flush()

        elif etype == "system" and event.get("subtype") not in ("init", "hook_started", "hook_response"):
            # Show other system events (errors, warnings)
            subtype = event.get("subtype", "")
            msg = event.get("message", event.get("error", ""))
            if msg:
                out.write(f"        {_DIM}system/{subtype}: {str(msg)[:200]}{_RESET}\n")
                out.flush()

        elif etype == "assistant":
            msg = event.get("message", {})
            for block in msg.get("content", []):
                btype = block.get("type", "")
                if btype == "tool_use":
                    tool_count += 1
                    stats["tool_calls"] = tool_count
                    name = block.get("name", "?")
                    args = block.get("input", {})
                    _write_tool_call(out, name, args, tool_count)
                elif btype == "tool_result":
                    _write_tool_result(out, block.get("content", ""))
                elif btype == "text":
                    text = block.get("text", "")
                    if text.strip():
                        _write_text_block(out, text)

        elif etype == "tool_result":
            _write_tool_result(out, event.get("content", ""))

        elif etype == "result":
            cost = event.get("total_cost_usd", 0)
            turns = event.get("num_turns", 0)
            duration = event.get("duration_ms", 0)
            stats["num_turns"] = turns
            stats["cost_usd"] = cost
            out.write(
                f"        {_GREEN}done: {turns} turns, {tool_count} tool calls, "
                f"${cost:.4f}, {duration / 1000:.1f}s{_RESET}\n"
            )
            out.flush()

        elif etype == "user":
            # Tool results come back as user messages with tool_result content
            msg = event.get("message", {})
            content = msg.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        _write_tool_result(out, block.get("content", ""))
            elif isinstance(content, str) and content.strip():
                out.write(f"        {_DIM}user: {content[:200]}{_RESET}\n")
                out.flush()

    proc.wait(timeout=600)
    if proc.returncode != 0:
        stderr_out = proc.stderr.read()
        if stderr_out:
            out.write(f"        {_RED}stderr: {stderr_out[:500]}{_RESET}\n")
            out.flush()
        logger.warning("Claude Code exited with code %d", proc.returncode)

    return stats


def _write_tool_result(out: Any, content: Any) -> None:
    """Write a formatted tool result to the trace output."""
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict):
                parts.append(c.get("text", str(c))[:300])
            else:
                parts.append(str(c)[:300])
        content_str = " ".join(parts)
    else:
        content_str = str(content)
    if len(content_str) > 300:
        content_str = content_str[:297] + "..."
    out.write(f"        {_DIM}  → {content_str}{_RESET}\n")
    out.flush()


def _write_tool_call(out: Any, name: str, args: Any, count: int) -> None:
    """Write a formatted tool call to the trace output."""
    if isinstance(args, dict):
        parts = []
        for k, v in args.items():
            sv = str(v)
            if len(sv) > 80:
                sv = sv[:77] + "..."
            parts.append(f"{k}={sv}")
        args_str = ", ".join(parts)
    else:
        args_str = str(args)[:200]

    out.write(f"        {_CYAN}[{count}] {_BOLD}{name}{_RESET}{_CYAN}({args_str}){_RESET}\n")
    out.flush()


def _write_text_block(out: Any, text: str) -> None:
    """Write Claude's text output to the trace, truncated."""
    lines = text.strip().split("\n")
    if len(lines) <= 3:
        for line in lines:
            out.write(f"        {_DIM}{line}{_RESET}\n")
    else:
        out.write(f"        {_DIM}{lines[0]}{_RESET}\n")
        out.write(f"        {_DIM}  ...({len(lines) - 2} more lines){_RESET}\n")
        out.write(f"        {_DIM}{lines[-1]}{_RESET}\n")
    out.flush()


def create_claude_code_agent_fn(
    *,
    model: str = "sonnet",
    max_turns: int = MAX_TURNS,
    claude_cmd: str = "claude",
    skip_permissions: bool = True,
    max_budget_usd: float | None = None,
    verbose: bool = False,
    plugin_dir: str | Path | None = None,
) -> Any:
    """Create an :data:`AgentFn` that uses Claude Code (the ``claude`` CLI).

    This is the recommended backend — Claude Code already has Read, Edit,
    Bash, Grep, Glob tools built-in, and the OpenTrace plugin provides
    graph query tools, agents (@code-explorer, @dependency-analyzer), and
    skills automatically.

    Parameters
    ----------
    model : str
        Model alias (``"sonnet"``, ``"opus"``, ``"haiku"``) or full model ID.
    max_turns : int
        Maximum conversation turns.
    claude_cmd : str
        Path to the ``claude`` CLI binary.
    skip_permissions : bool
        If True, run with ``--dangerously-skip-permissions`` (for sandboxed
        environments only).
    max_budget_usd : float or None
        Maximum dollar spend per instance.
    verbose : bool
        If True, stream Claude Code's output to stderr in real-time.
    plugin_dir : str, Path, or None
        Path to the OpenTrace plugin directory. If None, auto-detects from
        the repo layout (``claude-code-plugin/`` next to ``agent/``).
    """
    cmd = shutil.which(claude_cmd)
    if cmd is None:
        raise FileNotFoundError(f"'{claude_cmd}' not found on PATH. Install Claude Code first.")

    # Resolve plugin directory
    resolved_plugin_dir = Path(plugin_dir) if plugin_dir else PLUGIN_DIR
    has_plugin = resolved_plugin_dir.is_dir() and (resolved_plugin_dir / ".claude-plugin" / "plugin.json").exists()
    if not has_plugin:
        logger.warning("OpenTrace plugin not found at %s — falling back to raw MCP config", resolved_plugin_dir)

    def agent_fn(
        problem_statement: str,
        repo_path: Path,
        mcp_config: dict[str, Any] | None,
    ) -> str:
        """Solve a SWE-bench instance using Claude Code."""
        import sys

        out = sys.stderr
        use_opentrace = mcp_config is not None
        explore = EXPLORE_WITH_OT if use_opentrace else EXPLORE_WITHOUT_OT

        prompt = CLAUDE_CODE_PROMPT.format(
            problem_statement=problem_statement,
            repo_path=repo_path,
            explore_instruction=explore,
        )

        args = [
            claude_cmd,
            "--print",
            "--bare",  # Clean env: no other plugins/hooks. Requires ANTHROPIC_API_KEY.
            "--model",
            model,
            "--no-session-persistence",
        ]

        # Use stream-json when verbose so we can parse tool calls in real time.
        # Use json (single result) when not verbose to still capture cost/turns.
        # (stream-json requires --verbose on the claude CLI side)
        if verbose:
            args.extend(["--output-format", "stream-json", "--verbose"])
        else:
            args.extend(["--output-format", "json"])

        if skip_permissions:
            args.append("--dangerously-skip-permissions")

        if max_budget_usd is not None:
            args.extend(["--max-budget-usd", str(max_budget_usd)])

        # With OpenTrace: give Claude Code the full plugin (agents, skills,
        # MCP tools) plus an MCP config pointing at the specific index DB.
        # --strict-mcp-config blocks all MCP servers (including other
        # installed plugins like linear/sentry/firebase) except what we
        # explicitly pass via --mcp-config.
        args.append("--strict-mcp-config")

        if mcp_config and "db_path" in mcp_config:
            # Resolve to absolute path — the MCP server runs from a
            # different cwd so relative paths won't work.
            db_path = str(Path(mcp_config["db_path"]).resolve())
            ot_cmd = mcp_config.get("command", "opentraceai")

            if has_plugin:
                args.extend(["--plugin-dir", str(resolved_plugin_dir)])

            # Write MCP config to a temp file to avoid shell quoting issues
            # with inline JSON strings.
            mcp_config_data = {
                "mcpServers": {
                    "opentrace-oss": {
                        "command": ot_cmd,
                        "args": ["mcp", "--db", db_path],
                    }
                }
            }
            import tempfile

            mcp_config_file = Path(tempfile.mktemp(suffix=".json", prefix="ot_mcp_"))
            mcp_config_file.write_text(json.dumps(mcp_config_data, indent=2))
            args.extend(["--mcp-config", str(mcp_config_file)])

        # Pipe the prompt via stdin — it's too long for a CLI argument
        args.append("-p")

        logger.info("Running Claude Code in %s", repo_path)

        repo_path_abs = str(Path(repo_path).resolve())

        if verbose:
            # Log the full command (mask the prompt since it's piped via stdin)
            cmd_display = " ".join(args)
            out.write(f"        {_DIM}cmd: {cmd_display}{_RESET}\n")
            out.write(f"        {_DIM}cwd: {repo_path_abs}{_RESET}\n")
            out.flush()

        try:
            if verbose:
                trace_stats = _run_claude_code_traced(args, repo_path_abs, prompt, sys.stderr)
                agent_fn.last_stats = trace_stats
            else:
                proc_result = subprocess.run(
                    args,
                    cwd=repo_path_abs,
                    input=prompt,
                    capture_output=True,
                    text=True,
                    timeout=600,
                )
                # Parse JSON output to extract cost/turns
                try:
                    result_data = json.loads(proc_result.stdout)
                    agent_fn.last_stats = {
                        "num_turns": result_data.get("num_turns", 0),
                        "cost_usd": result_data.get("total_cost_usd", 0.0),
                        "tool_calls": 0,
                    }
                except (json.JSONDecodeError, TypeError):
                    agent_fn.last_stats = {"num_turns": 0, "cost_usd": 0.0, "tool_calls": 0}
                if proc_result.returncode != 0:
                    logger.warning(
                        "Claude Code exited with code %d: %s",
                        proc_result.returncode,
                        proc_result.stderr[:500],
                    )

        except subprocess.TimeoutExpired:
            logger.error("Claude Code timed out after 600s")
            return ""

        # Capture the patch as git diff of working tree changes
        try:
            diff_result = subprocess.run(
                ["git", "diff"],
                cwd=repo_path_abs,
                capture_output=True,
                text=True,
                timeout=30,
            )
            patch = diff_result.stdout.strip()
        except Exception as e:
            logger.error("Failed to capture git diff: %s", e)
            patch = ""

        if not patch:
            # Also check for staged changes
            try:
                diff_result = subprocess.run(
                    ["git", "diff", "--cached"],
                    cwd=str(repo_path),
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                patch = diff_result.stdout.strip()
            except Exception:
                pass

        if patch:
            logger.info("Captured patch (%d bytes)", len(patch))
        else:
            logger.warning("No changes detected in working tree")

        return patch

    agent_fn.last_stats = {"num_turns": 0, "cost_usd": 0.0, "tool_calls": 0}  # type: ignore[attr-defined]
    return agent_fn


# ---------------------------------------------------------------------------
# CLI entry points
# ---------------------------------------------------------------------------


def _make_progress_callback(verbose: bool) -> Any:
    """Create a progress callback for SWE-bench runs."""
    if not verbose:
        return None

    import click

    def on_progress(index: int, total: int, result: Any) -> None:
        if result.error:
            icon = "ERROR"
        elif result.success:
            icon = "PASS"
        else:
            icon = "FAIL"
        patch_info = f", patch={len(result.generated_patch)}B" if result.generated_patch else ""
        index_info = f", index={result.index_duration_s:.1f}s" if result.index_duration_s else ""
        agent_info = f", agent={result.agent_duration_s:.1f}s" if result.agent_duration_s else ""
        click.echo(
            f"  [{index}/{total}] [{icon:>5}] {result.instance_id} "
            f"({result.duration_s:.1f}s{index_info}{agent_info}{patch_info})"
        )
        if result.error:
            click.echo(f"          {result.error}")

    return on_progress


def run_swe_bench_cli(
    instances_path: str,
    *,
    model: str = "claude-sonnet-4-20250514",
    work_dir: str | None = None,
    use_opentrace: bool = True,
    limit: int | None = None,
    compare: bool = False,
    backend: str = "api",
    workers: int = 1,
    verbose: bool = False,
) -> None:
    """CLI entry point for running SWE-bench evaluation."""
    import click

    from opentrace_agent.benchmarks.swe_bench import SWEBenchHarness, compare_reports

    if backend == "claude-code":
        agent_fn = create_claude_code_agent_fn(model=model, verbose=verbose)
    else:
        agent_fn = create_agent_fn(model=model)

    harness = SWEBenchHarness(work_dir=work_dir)
    progress = _make_progress_callback(verbose)

    label = "WITH" if use_opentrace else "WITHOUT"
    if verbose:
        instances = harness.load_instances(instances_path)
        count = min(limit, len(instances)) if limit else len(instances)
        workers_info = f", {workers} workers" if workers > 1 else ""
        click.echo(f"SWE-bench: {count} instances, {label} OpenTrace, backend={backend}, model={model}{workers_info}")
        click.echo()

    if compare:
        if verbose:
            click.echo("--- Pass 1: WITH OpenTrace ---")
        report_with = harness.run(
            instances_path,
            agent_fn,
            use_opentrace=True,
            limit=limit,
            on_progress=progress,
            workers=workers,
        )
        if verbose:
            click.echo()
            click.echo("--- Pass 2: WITHOUT OpenTrace ---")
        report_without = harness.run(
            instances_path,
            agent_fn,
            use_opentrace=False,
            limit=limit,
            on_progress=progress,
            workers=workers,
        )
        if verbose:
            click.echo()
        click.echo(report_with.summary(verbose=verbose))
        click.echo()
        click.echo(report_without.summary(verbose=verbose))
        click.echo()
        click.echo(compare_reports(report_with, report_without))
    else:
        report = harness.run(
            instances_path,
            agent_fn,
            use_opentrace=use_opentrace,
            limit=limit,
            on_progress=progress,
            workers=workers,
        )
        if verbose:
            click.echo()
        click.echo(report.summary(verbose=verbose))
