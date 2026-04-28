#!/usr/bin/env python3
"""Install the OpenTrace Codex hook bundle into ~/.codex or <repo>/.codex.

The hooks (SessionStart / UserPromptSubmit / PreToolUse) prime Codex with
OpenTrace tool-routing guidance and augment shell rg/grep/cat with graph
context.  Hooks are independent of the plugin marketplace flow — they
need a separate one-time install because Codex hook config lives in
~/.codex/, not inside a plugin bundle.

Usage:
    install.sh --home [--mode copy|symlink] [--force]
    install.sh --repo /path/to/project [--mode copy|symlink] [--force]

The installer:
    1. Copies (or symlinks) .codex/hooks/*.py to <target>/.codex/hooks/
    2. Copies .codex/hooks.json to <target>/.codex/hooks.json (warns if
       one already exists with different content unless --force).
    3. Ensures <target>/.codex/config.toml has `codex_hooks = true` under
       [features], creating or merging as needed.

It does NOT modify ~/.codex/config.toml's plugin or marketplace stanzas
— that's handled by `codex plugin marketplace add`.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
from typing import List


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def source_codex_dir() -> Path:
    return repo_root() / ".codex"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install OpenTrace Codex hooks (session-start, "
                    "user-prompt-submit, pre-tool-use)."
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--home", action="store_true",
                        help="Install into ~/.codex (recommended)")
    target.add_argument("--repo", help="Install into <repo>/.codex")
    parser.add_argument("--mode", choices=("copy", "symlink"), default="copy",
                        help="copy (default) or symlink the hook scripts")
    parser.add_argument("--force", action="store_true",
                        help="Overwrite conflicting destination files")
    return parser.parse_args()


def target_root(args: argparse.Namespace) -> Path:
    if args.home:
        return Path.home().resolve()
    return Path(args.repo).expanduser().resolve()


# ---------------------------------------------------------------------------
# File install primitives
# ---------------------------------------------------------------------------

def _same_link(dest: Path, src: Path) -> bool:
    return dest.is_symlink() and dest.resolve() == src.resolve()


def _same_contents(src: Path, dest: Path) -> bool:
    return dest.exists() and src.read_bytes() == dest.read_bytes()


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def install_file(src: Path, dest: Path, mode: str, force: bool) -> str:
    """Install one file. Returns a status string for the install report."""
    dest.parent.mkdir(parents=True, exist_ok=True)

    if mode == "symlink":
        if dest.exists() or dest.is_symlink():
            if _same_link(dest, src):
                return f"unchanged (symlink): {dest}"
            if not force:
                raise FileExistsError(
                    f"{dest} exists and isn't the expected symlink. "
                    "Re-run with --force to overwrite."
                )
            _remove(dest)
        dest.symlink_to(src)
        return f"symlinked: {dest} -> {src}"

    # copy mode
    if dest.exists():
        if _same_contents(src, dest):
            return f"unchanged: {dest}"
        if not force:
            raise FileExistsError(
                f"{dest} exists with different content. "
                "Re-run with --force to overwrite."
            )
    shutil.copy2(src, dest)
    return f"copied: {dest}"


# ---------------------------------------------------------------------------
# config.toml [features] merging
# ---------------------------------------------------------------------------

FEATURE_LINE = "codex_hooks = true"


def ensure_feature_flag(config_path: Path) -> str:
    """Make sure config_path has `codex_hooks = true` under [features].

    Creates the file from our template if missing; otherwise minimally
    edits the existing file.  Returns a status string.
    """
    if not config_path.exists():
        config_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_codex_dir() / "config.toml", config_path)
        return f"created: {config_path}"

    text = config_path.read_text()
    if FEATURE_LINE in text:
        return f"unchanged: {config_path} already has {FEATURE_LINE}"

    lines = text.splitlines()
    inserted = False
    for i, line in enumerate(lines):
        if line.strip() == "[features]":
            insert_at = i + 1
            while insert_at < len(lines) and not lines[insert_at].startswith("["):
                insert_at += 1
            lines.insert(insert_at, FEATURE_LINE)
            inserted = True
            break

    if not inserted:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(["[features]", FEATURE_LINE])

    config_path.write_text("\n".join(lines) + "\n")
    return f"updated: {config_path} (added {FEATURE_LINE})"


# ---------------------------------------------------------------------------
# Top-level orchestration
# ---------------------------------------------------------------------------

def install(args: argparse.Namespace) -> List[str]:
    src_codex = source_codex_dir()
    dest_codex = target_root(args) / ".codex"
    src_hooks = src_codex / "hooks"
    dest_hooks = dest_codex / "hooks"
    report: List[str] = []

    dest_hooks.mkdir(parents=True, exist_ok=True)
    for src_file in sorted(src_hooks.glob("*.py")):
        report.append(install_file(src_file, dest_hooks / src_file.name, args.mode, args.force))

    report.append(install_file(
        src_codex / "hooks.json",
        dest_codex / "hooks.json",
        args.mode,
        args.force,
    ))

    report.append(ensure_feature_flag(dest_codex / "config.toml"))
    return report


def main() -> int:
    args = parse_args()
    if not source_codex_dir().is_dir():
        print(f"error: source .codex/ not found at {source_codex_dir()}",
              file=sys.stderr)
        return 1
    try:
        report = install(args)
    except FileExistsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print("OpenTrace Codex hooks installed.")
    for line in report:
        print(f"  {line}")
    print("\nRestart any active Codex session to pick up the hooks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())