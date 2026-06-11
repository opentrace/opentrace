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

"""``opentraceai hook`` — manage a post-commit git hook for incremental indexing.

Installs a small shell script as ``.git/hooks/post-commit`` that invokes
``opentraceai index --incremental`` after every commit. Uninstall removes
it; status reports whether it's currently active.

The hook content is a single ``exec`` line so it composes with other tools
that wrap the same hook — we check for our marker on read/write to avoid
clobbering hand-authored hooks.

SCAFFOLDING: ``index --incremental`` does not exist yet — incremental
indexing never landed after the integration. The installed hook therefore
exits silently on every commit (the ``|| true`` swallows the unknown-flag
error). Install/uninstall/status mechanics are real and tested; the
re-index itself starts working the day the flag ships, with no change to
already-installed hooks needed beyond that.
"""

from __future__ import annotations

import logging
import os
import stat
from pathlib import Path

import click

logger = logging.getLogger(__name__)

MARKER = "# opentraceai post-commit hook"
HOOK_BODY = (
    "#!/usr/bin/env bash\n"
    f"{MARKER}\n"
    "# Re-index incrementally after each commit. Failures are non-fatal —\n"
    "# the commit succeeds even if indexing breaks.\n"
    "# NOTE: `index --incremental` is not implemented yet; until it ships\n"
    "# this hook is a safe no-op (the `|| true` hides the unknown flag).\n"
    "if command -v opentraceai >/dev/null 2>&1; then\n"
    "  opentraceai index --incremental >/dev/null 2>&1 || true\n"
    "fi\n"
)


def _hooks_dir(repo_root: Path) -> Path:
    """Return ``.git/hooks/`` for a working tree, resolving git-worktree layouts."""
    git_path = repo_root / ".git"
    if git_path.is_file():
        # Worktree: .git is a file like `gitdir: /path/to/main/.git/worktrees/foo`
        text = git_path.read_text().strip()
        if text.startswith("gitdir:"):
            target = Path(text.split(":", 1)[1].strip())
            return target / "hooks"
    return git_path / "hooks"


def _find_repo_root(start: Path) -> Path | None:
    """Return the git repo root above ``start``, or ``None`` if none exists.

    Walks parent directories one step at a time, stopping at the filesystem
    root. A ``.git`` directory or worktree-pointer file marks the root.
    """
    candidate = start.resolve()
    while not (candidate / ".git").exists():
        if candidate.parent == candidate:
            return None
        candidate = candidate.parent
    return candidate


def install_hook(repo_root: Path) -> Path:
    """Write the post-commit hook. Returns the hook path.

    Refuses to overwrite an existing hook unless it already carries our marker,
    so hand-authored hooks survive.
    """
    hooks = _hooks_dir(repo_root)
    if not hooks.exists():
        hooks.mkdir(parents=True, exist_ok=True)
    hook_path = hooks / "post-commit"
    if hook_path.exists():
        existing = hook_path.read_text()
        if MARKER not in existing:
            raise click.ClickException(
                f"{hook_path} already exists and was not written by opentraceai. Inspect it manually before installing."
            )
    hook_path.write_text(HOOK_BODY)
    # Make it executable: rwxr-xr-x.
    hook_path.chmod(hook_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return hook_path


def uninstall_hook(repo_root: Path) -> bool:
    """Remove the post-commit hook iff it carries our marker. Returns True if removed."""
    hook_path = _hooks_dir(repo_root) / "post-commit"
    if not hook_path.exists():
        return False
    if MARKER not in hook_path.read_text():
        raise click.ClickException(f"{hook_path} was not written by opentraceai. Remove it manually.")
    hook_path.unlink()
    return True


def hook_status(repo_root: Path) -> dict[str, object]:
    """Return ``{installed, path, executable}`` for the post-commit hook."""
    hook_path = _hooks_dir(repo_root) / "post-commit"
    if not hook_path.exists():
        return {"installed": False, "path": str(hook_path), "executable": False}
    has_marker = MARKER in hook_path.read_text()
    mode = hook_path.stat().st_mode
    return {
        "installed": has_marker,
        "path": str(hook_path),
        "executable": bool(mode & stat.S_IXUSR),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@click.group("hook")
def hook_app() -> None:
    """Manage the OpenTrace post-commit git hook."""


def _resolve_repo(path: str | None) -> Path:
    start = Path(path) if path else Path(os.getcwd())
    root = _find_repo_root(start)
    if root is None:
        raise click.ClickException(f"Not a git repository (or any parent): {start}")
    return root


@hook_app.command("install")
@click.option("--repo", "repo_path", default=None, type=click.Path(), help="Repo root (defaults to cwd).")
def install_cmd(repo_path: str | None) -> None:
    """Write a post-commit hook that re-indexes incrementally."""
    repo = _resolve_repo(repo_path)
    hook_path = install_hook(repo)
    click.echo(f"Installed hook: {hook_path}")


@hook_app.command("uninstall")
@click.option("--repo", "repo_path", default=None, type=click.Path(), help="Repo root (defaults to cwd).")
def uninstall_cmd(repo_path: str | None) -> None:
    """Remove the opentraceai post-commit hook (no-op if missing)."""
    repo = _resolve_repo(repo_path)
    if uninstall_hook(repo):
        click.echo("Hook removed.")
    else:
        click.echo("No hook to remove.")


@hook_app.command("status")
@click.option("--repo", "repo_path", default=None, type=click.Path(), help="Repo root (defaults to cwd).")
def status_cmd(repo_path: str | None) -> None:
    """Report whether the opentraceai post-commit hook is installed."""
    repo = _resolve_repo(repo_path)
    status = hook_status(repo)
    if status["installed"]:
        click.echo(f"Installed: {status['path']} (executable: {status['executable']})")
    elif Path(status["path"]).exists():  # type: ignore[arg-type]
        click.echo(f"A different hook is at {status['path']} — opentraceai is NOT installed.")
    else:
        click.echo("Not installed.")
