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

"""``opentraceai wiki`` CLI subcommand — compile files into a vault."""

from __future__ import annotations

import fnmatch
import os
import sys
from collections.abc import Iterable, Iterator
from pathlib import Path

import click

# Directory components we skip when walking a folder unless the user opts
# back in via ``--no-default-excludes``. These are caches, VCS metadata,
# and previously-compiled vaults — virtually never the inputs the user
# wants to feed an LLM.
DEFAULT_EXCLUDED_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".idea",
        ".vscode",
        ".opentrace",
    }
)


@click.group()
def wiki() -> None:
    """Knowledge-vault commands (compile uploaded files into a markdown wiki)."""


@wiki.command("compile")
@click.argument("vault_name")
@click.argument(
    "paths",
    nargs=-1,
    required=True,
    type=click.Path(exists=True, resolve_path=True),
)
@click.option(
    "--include",
    multiple=True,
    metavar="GLOB",
    help=(
        "Glob (fnmatch) included files must match. Repeat for multiple "
        "patterns; matched against both the basename and the path "
        "relative to the input root. Only applies when walking folders."
    ),
)
@click.option(
    "--exclude",
    multiple=True,
    metavar="GLOB",
    help=(
        "Glob (fnmatch) for files to skip. Repeat for multiple patterns. "
        "Applied on top of the default excludes unless "
        "--no-default-excludes is set."
    ),
)
@click.option(
    "--no-default-excludes",
    is_flag=True,
    default=False,
    help=("Disable the built-in directory excludes (.git, node_modules, __pycache__, .venv, .opentrace, …)."),
)
@click.option(
    "--hidden/--no-hidden",
    default=False,
    show_default=True,
    help="Include dotfiles and files inside dotfile-prefixed directories.",
)
@click.option(
    "--provider",
    type=click.Choice(["anthropic", "gemini", "openai", "local"]),
    default=None,
    help=(
        "LLM provider to drive Plan + Execute calls. If omitted, picks the "
        "first provider with a key set in the environment "
        "(ANTHROPIC_API_KEY → GEMINI/GOOGLE_API_KEY → OPENAI_API_KEY), "
        "falling back to anthropic."
    ),
)
@click.option(
    "--api-key",
    default=None,
    help=(
        "Provider API key. Falls back to ANTHROPIC_API_KEY / "
        "GEMINI_API_KEY / OPENAI_API_KEY depending on --provider. "
        "Local endpoints don't require a key."
    ),
)
@click.option(
    "--model",
    default=None,
    help="Override the provider's default model.",
)
@click.option(
    "--base-url",
    default=None,
    help=(
        "Base URL for OpenAI-compatible local endpoints (e.g. "
        "http://localhost:11434). Required when --provider=local "
        "unless $OT_LOCAL_LLM_URL is set."
    ),
)
@click.option(
    "--vault-root",
    default=None,
    type=click.Path(),
    help="Vault root directory (default: ~/.opentrace/vaults; or set OT_VAULT_ROOT).",
)
@click.option(
    "--db",
    default=None,
    type=click.Path(),
    help="Mirror the compiled vault into this graph DB. Auto-discovered if omitted.",
)
@click.option(
    "--no-graph/--graph",
    default=False,
    show_default=True,
    help="Skip the graph mirror step entirely (disk only).",
)
def wiki_compile(
    vault_name: str,
    paths: tuple[str, ...],
    include: tuple[str, ...],
    exclude: tuple[str, ...],
    no_default_excludes: bool,
    hidden: bool,
    provider: str | None,
    api_key: str | None,
    model: str | None,
    base_url: str | None,
    vault_root: str | None,
    db: str | None,
    no_graph: bool,
) -> None:
    """Compile PATHS into VAULT_NAME, producing connected markdown pages.

    PATHS may be individual files, folders, or a mix. Folders are walked
    recursively; --include / --exclude globs and the default excludes apply
    only when walking. Files passed by name are always included.
    """
    from opentrace_agent.wiki import SourceInput, run_compile
    from opentrace_agent.wiki.ingest.types import WikiEventKind

    if provider is None:
        provider = _autodetect_provider()

    collected = list(
        _collect_inputs(
            [Path(p) for p in paths],
            includes=list(include),
            excludes=list(exclude),
            apply_default_excludes=not no_default_excludes,
            include_hidden=hidden,
        )
    )
    if not collected:
        raise click.ClickException("no files to compile — every input was filtered out by the include/exclude rules.")

    inputs: list[SourceInput] = []
    for path in collected:
        inputs.append(SourceInput(name=path.name, data=path.read_bytes()))

    click.echo(f"Compiling {len(inputs)} file(s) into vault {vault_name!r} via {provider} ...")

    graph_store = None
    if not no_graph:
        graph_store = _open_graph_store(db)

    try:
        for event in run_compile(
            vault_name,
            inputs,
            provider=provider,
            api_key=api_key,
            model=model,
            base_url=base_url,
            vault_root=vault_root,
            graph_store=graph_store,
        ):
            _print_event(event)
            if event.kind == WikiEventKind.ERROR:
                sys.exit(2)
    except RuntimeError as e:
        raise click.ClickException(str(e))
    finally:
        if graph_store is not None:
            graph_store.close()


@wiki.command("backfill")
@click.argument("vault_name")
@click.option(
    "--vault-root",
    default=None,
    type=click.Path(),
    help="Vault root directory (default: ~/.opentrace/vaults; or set OT_VAULT_ROOT).",
)
@click.option(
    "--db",
    default=None,
    type=click.Path(),
    help="Graph DB to write into. Auto-discovered if omitted.",
)
def wiki_backfill(
    vault_name: str,
    vault_root: str | None,
    db: str | None,
) -> None:
    """Mirror an on-disk vault into the graph without recompiling.

    Use after upgrading from a pre-OT-1732 install (where vaults compiled
    only to disk) or after a graph-write failure during compile.
    """
    from opentrace_agent.wiki.ingest.graph_writer import write_vault_to_graph
    from opentrace_agent.wiki.paths import metadata_path, pages_dir
    from opentrace_agent.wiki.vault import load_metadata

    vault_root_path = Path(vault_root) if vault_root else None
    meta_path = metadata_path(vault_name, vault_root_path)
    if not meta_path.exists():
        raise click.ClickException(f"vault not found: {vault_name}")
    pages_path = pages_dir(vault_name, vault_root_path)

    meta = load_metadata(meta_path, name=vault_name)
    page_bodies: dict[str, str] = {}
    for slug in meta.pages.keys():
        body_path = pages_path / f"{slug}.md"
        try:
            page_bodies[slug] = body_path.read_text()
        except OSError:
            page_bodies[slug] = ""

    graph_store = _open_graph_store(db)
    if graph_store is None:
        raise click.ClickException("no graph DB available — run `opentraceai index` to create one or pass --db")
    try:
        stats = write_vault_to_graph(graph_store, meta, page_bodies)
    finally:
        graph_store.close()

    click.echo(f"Backfilled vault {vault_name!r}: {stats['nodes_written']} nodes, {stats['rels_written']} rels.")


@wiki.command("list")
@click.option(
    "--vault-root",
    default=None,
    type=click.Path(),
    help="Vault root directory (default: ~/.opentrace/vaults; or set OT_VAULT_ROOT).",
)
def wiki_list(vault_root: str | None) -> None:
    """List all compiled vaults under the vault root."""
    from opentrace_agent.wiki.paths import list_vaults, metadata_path
    from opentrace_agent.wiki.paths import vault_root as resolve_root
    from opentrace_agent.wiki.vault import load_metadata

    vault_root_path = Path(vault_root) if vault_root else None
    root = resolve_root(vault_root_path)
    names = list_vaults(vault_root_path)
    if not names:
        click.echo(f"No vaults under {root} — use `opentraceai wiki compile` to create one.")
        return

    click.echo(f"Vaults under {root}:")
    for name in names:
        meta_path = metadata_path(name, vault_root_path)
        if not meta_path.exists():
            click.echo(f"  {name}  (no metadata)")
            continue
        try:
            meta = load_metadata(meta_path, name=name)
        except Exception as e:  # noqa: BLE001 — informational listing
            click.echo(f"  {name}  (unreadable: {e})")
            continue
        compiled = meta.last_compiled_at or "never"
        click.echo(f"  {name}  pages={len(meta.pages)}  last_compiled={compiled}")


@wiki.command("show")
@click.argument("vault_name")
@click.option(
    "--vault-root",
    default=None,
    type=click.Path(),
    help="Vault root directory (default: ~/.opentrace/vaults; or set OT_VAULT_ROOT).",
)
@click.option(
    "--page",
    default=None,
    metavar="SLUG",
    help="Print the markdown body of a specific page slug instead of the index.",
)
def wiki_show(vault_name: str, vault_root: str | None, page: str | None) -> None:
    """Show the page index for a vault, or the body of one page with --page."""
    from opentrace_agent.wiki.paths import metadata_path, pages_dir
    from opentrace_agent.wiki.vault import load_metadata

    vault_root_path = Path(vault_root) if vault_root else None
    meta_path = metadata_path(vault_name, vault_root_path)
    if not meta_path.exists():
        raise click.ClickException(f"vault not found: {vault_name}")
    meta = load_metadata(meta_path, name=vault_name)

    if page is not None:
        body_path = pages_dir(vault_name, vault_root_path) / f"{page}.md"
        if not body_path.exists():
            raise click.ClickException(
                f"page not found: {page} (use `opentraceai wiki show {vault_name}` to list slugs)"
            )
        click.echo(body_path.read_text())
        return

    click.echo(f"Vault: {vault_name}")
    click.echo(f"Last compiled: {meta.last_compiled_at or 'never'}")
    click.echo(f"Pages: {len(meta.pages)}")
    click.echo()
    if not meta.pages:
        return
    # Sort: concept pages first, then source-summaries, alphabetical within.
    pages = sorted(
        meta.pages.values(),
        key=lambda p: (0 if (p.kind or "concept") == "concept" else 1, p.slug),
    )
    for p in pages:
        kind = p.kind or "concept"
        click.echo(f"  [{kind}] {p.slug}")
        click.echo(f"      title:   {p.title}")
        click.echo(f"      summary: {p.one_line_summary}")


def _collect_inputs(
    paths: Iterable[Path],
    *,
    includes: list[str],
    excludes: list[str],
    apply_default_excludes: bool,
    include_hidden: bool,
) -> Iterator[Path]:
    """Yield files for each input path, expanding directories.

    Files passed by name are always emitted (the user named them
    explicitly). Directories are walked recursively with the include /
    exclude globs and default-exclude rules applied. Symlinks are not
    followed during the walk to avoid cycles.
    """
    for path in paths:
        if path.is_file():
            yield path
            continue
        if not path.is_dir():
            continue
        yield from _walk_dir(
            path,
            includes=includes,
            excludes=excludes,
            apply_default_excludes=apply_default_excludes,
            include_hidden=include_hidden,
        )


def _walk_dir(
    root: Path,
    *,
    includes: list[str],
    excludes: list[str],
    apply_default_excludes: bool,
    include_hidden: bool,
) -> Iterator[Path]:
    """Walk *root*, yielding files that pass the filter rules."""
    # Use os.walk so we can prune excluded directories before descending —
    # cheaper than walking everything and filtering, and avoids stat-ing
    # files inside huge node_modules / .git trees.
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dir_path = Path(dirpath)
        # Mutate dirnames in place to prune the walk.
        dirnames[:] = [
            d
            for d in dirnames
            if (include_hidden or not d.startswith("."))
            and (not apply_default_excludes or d not in DEFAULT_EXCLUDED_DIRS)
        ]
        for fname in filenames:
            if not include_hidden and fname.startswith("."):
                continue
            file_path = dir_path / fname
            rel = file_path.relative_to(root).as_posix()
            if excludes and _matches_any(rel, fname, excludes):
                continue
            if includes and not _matches_any(rel, fname, includes):
                continue
            yield file_path


def _matches_any(rel_path: str, basename: str, patterns: list[str]) -> bool:
    """True if *rel_path* or *basename* matches any fnmatch pattern."""
    for pat in patterns:
        if fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(basename, pat):
            return True
    return False


def _autodetect_provider() -> str:
    """Pick a provider from env when --provider was omitted.

    Anthropic wins if its key is set, since that was the historical default.
    Falls back to anthropic when nothing is set so the resolver surfaces the
    standard "API key missing" error.
    """
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return "gemini"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    return "anthropic"


def _open_graph_store(db: str | None):
    """Open a GraphStore for vault graph mirroring, or return None.

    Resolves *db* explicitly when given, otherwise falls back to
    :func:`opentrace_agent.cli.main.find_db` which walks up to the git root
    looking for ``.opentrace/index.db``. If the DB is held by another
    writer (typically a running ``opentraceai serve``), raises a
    :class:`click.ClickException` with a message that explains the
    situation rather than the raw LadybugDB lock error.
    """
    from opentrace_agent.cli.main import find_db
    from opentrace_agent.store import GraphStore

    if db is not None:
        path = Path(db)
    else:
        found = find_db()
        if found is None:
            return None
        path = found
    try:
        return GraphStore(str(path))
    except RuntimeError as e:
        # LadybugDB surfaces concurrent-writer attempts as a generic
        # RuntimeError — string-match the lock marker so we don't swallow
        # unrelated IO errors.
        if "Could not set lock on file" not in str(e):
            raise
        raise click.ClickException(
            f"graph DB at {path} is held by another process — typically a "
            "running `opentraceai serve` backing the UI. Either stop that "
            "server and retry, use the UI's `Add vault…` modal (which "
            "compiles through the same server), or pass `--no-graph` to "
            "skip the graph mirror and run `opentraceai wiki backfill "
            "<vault>` later."
        ) from e


def _print_event(event) -> None:
    from opentrace_agent.wiki.ingest.types import WikiEventKind

    if event.kind == WikiEventKind.STAGE_START:
        click.echo(f"  [{event.phase.value}] {event.message}")
    elif event.kind == WikiEventKind.STAGE_PROGRESS:
        if event.total > 0:
            click.echo(f"    [{event.current}/{event.total}] {event.message}")
        else:
            click.echo(f"    {event.message}")
    elif event.kind == WikiEventKind.STAGE_STOP:
        click.echo(f"  [{event.phase.value}] {event.message}")
    elif event.kind == WikiEventKind.DONE:
        click.echo(f"Done: {event.message}")
    elif event.kind == WikiEventKind.ERROR:
        click.echo(f"Error: {event.message}", err=True)
