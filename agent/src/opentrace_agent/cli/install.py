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

"""`opentraceai install <target>` — wire OpenTrace into a coding agent.

Currently supports Claude Code, which has a native plugin system. Rather
than copy files around, this delegates to Claude Code's own plugin CLI:
it adds the OpenTrace marketplace (pulled online from the GitHub repo) and
installs the plugin from it, so the native update/uninstall channel stays
intact.

    opentraceai install claude

The marketplace source defaults to the public repo but is overridable via
``--source`` or ``$OPENTRACE_MARKETPLACE_SOURCE`` (for forks / local checkouts).
"""

from __future__ import annotations

import os
import shutil
import subprocess

import click

# owner/repo (or URL / local path) the `claude` CLI pulls the marketplace from.
DEFAULT_MARKETPLACE_SOURCE = "opentrace/opentrace"
# Marketplace + plugin names as declared in ./.claude-plugin/marketplace.json.
MARKETPLACE_NAME = "opentrace-oss"
PLUGIN_SPEC = "opentrace-oss@opentrace-oss"


def _marketplace_source(override: str | None) -> str:
    return override or os.environ.get("OPENTRACE_MARKETPLACE_SOURCE") or DEFAULT_MARKETPLACE_SOURCE


def _run(cmd: list[str], *, dry_run: bool) -> tuple[bool, str]:
    """Run *cmd*, returning ``(ok, combined_output)``. Never raises."""
    if dry_run:
        click.echo("  $ " + " ".join(cmd))
        return True, ""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=False)
    except FileNotFoundError:
        return False, f"{cmd[0]} not found on PATH"
    except subprocess.TimeoutExpired:
        return False, f"`{' '.join(cmd)}` timed out"
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    return proc.returncode == 0, out


def _last_line(text: str) -> str:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def install_claude(source: str, *, dry_run: bool) -> None:
    """Add the OpenTrace marketplace and install the plugin via the claude CLI.

    Raises ``click.ClickException`` on a hard failure.
    """
    if not dry_run and shutil.which("claude") is None:
        raise click.ClickException(
            "`claude` CLI not found on PATH — install Claude Code first "
            "(https://claude.com/claude-code), then re-run `opentraceai install claude`."
        )

    click.echo(f"Installing the OpenTrace plugin into Claude Code (marketplace source: {source}) ...")

    ok, out = _run(["claude", "plugin", "marketplace", "add", source], dry_run=dry_run)
    if ok:
        click.echo(f"  ✓ marketplace add {source}" + (f": {_last_line(out)}" if _last_line(out) else ""))
    elif "already" in out.lower():
        click.echo(f"  ✓ marketplace {MARKETPLACE_NAME}: already added")
    else:
        raise click.ClickException(f"`claude plugin marketplace add` failed: {out or 'unknown error'}")

    ok, out = _run(["claude", "plugin", "install", PLUGIN_SPEC], dry_run=dry_run)
    if ok:
        click.echo(f"  ✓ plugin install {PLUGIN_SPEC}" + (f": {_last_line(out)}" if _last_line(out) else ""))
    elif "already" in out.lower():
        click.echo(f"  ✓ plugin {PLUGIN_SPEC}: already installed")
    else:
        raise click.ClickException(f"`claude plugin install` failed: {out or 'unknown error'}")

    if dry_run:
        click.echo("\n(dry run — no changes made)")
    else:
        click.echo("\nDone. Restart Claude Code (or run /plugin) to load OpenTrace.")


# Map of install targets to their handlers. Slim by design — extend here
# (codex, cursor, …) or adopt the full multi-platform installer when ready.
_TARGETS = {
    "claude": install_claude,
}


def register(app: click.Group) -> None:
    """Mount the `install` command onto the root CLI group."""

    @app.command("install")
    @click.argument("target", type=click.Choice(sorted(_TARGETS), case_sensitive=False))
    @click.option(
        "--source",
        default=None,
        help="Marketplace source: owner/repo, URL, or local path. "
        "Defaults to $OPENTRACE_MARKETPLACE_SOURCE or 'opentrace/opentrace'.",
    )
    @click.option("--dry-run", is_flag=True, help="Print the commands that would run, without executing them.")
    def install_cmd(target: str, source: str | None, dry_run: bool) -> None:
        """Install the OpenTrace plugin into a coding agent.

        Currently supports Claude Code:

            opentraceai install claude
        """
        handler = _TARGETS[target.lower()]
        handler(_marketplace_source(source), dry_run=dry_run)
