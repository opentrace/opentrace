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

"""OpenTrace CLI — index local codebases into a LadybugDB knowledge graph."""

from __future__ import annotations

import errno
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

import click

from opentrace_agent.cli.workspace import (
    EXIT_DB_MISSING,
    EXIT_INDEX_IN_PROGRESS,
    EXIT_WORKSPACE_UNRESOLVABLE,
    resolve_workspace_db,
)

if TYPE_CHECKING:
    # Imported lazily at runtime (real_ladybug is a heavy native dep, and the
    # wiki stack pulls the LLM SDKs); only the type annotations need the names
    # at module scope.
    from opentrace_agent.store import GraphStore
    from opentrace_agent.wiki import SourceInput

# ---------------------------------------------------------------------------
# Database discovery
# ---------------------------------------------------------------------------

DB_NAME = "index.db"
OPENTRACE_DIR = ".opentrace"
_MAX_WALK_DEPTH = 10


def _find_git_root(start: Path) -> Path | None:
    """Find the nearest git repo root at or above *start*."""
    current = start.resolve()
    for _ in range(_MAX_WALK_DEPTH):
        if (current / ".git").exists():
            return current
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def _is_under(path: Path, root: Path) -> bool:
    """Check if *path* is at or under *root*."""
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _find_opentrace_dir(start: Path | None = None) -> Path | None:
    """Walk up from *start* looking for an existing ``.opentrace/`` directory.

    Security boundaries:
    - Stops at the git repo root (or filesystem root).
    - Rejects symlinks that resolve outside the boundary.
    - Caps upward traversal at ``_MAX_WALK_DEPTH`` levels.
    """
    if start is None:
        start = Path.cwd()
    start = start.resolve()

    git_root = _find_git_root(start)
    # Use git root as boundary only if start is inside it.
    boundary = git_root if git_root and _is_under(start, git_root) else Path(start.anchor)

    current = start
    for _ in range(_MAX_WALK_DEPTH):
        candidate = current / OPENTRACE_DIR
        if candidate.is_dir():
            resolved = candidate.resolve()
            # Reject if the resolved path escapes the repo boundary.
            if _is_under(resolved, boundary):
                return resolved
        # Stop at boundary or filesystem root.
        if current == boundary or current.parent == current:
            break
        current = current.parent

    return None


def find_db(start: Path | None = None) -> Path | None:
    """Walk up from *start* looking for ``.opentrace/index.db``.

    Security boundaries:
    - Stops at the git repo root (or filesystem root).
    - Rejects symlinks that resolve outside the boundary.
    - Caps upward traversal at ``_MAX_WALK_DEPTH`` levels.
    """
    ot_dir = _find_opentrace_dir(start)
    if ot_dir is not None:
        db_path = ot_dir / DB_NAME
        if db_path.exists():
            return db_path
    return None


def _resolve_db(db_path: str | None, *, must_exist: bool = False) -> str:
    """Return a database path from an explicit flag, ``--workspace``, or auto-discovery.

    Resolution order:
    1. Top-level ``--workspace``, threaded via ``ctx.obj["workspace_db"]``.
       Mutually exclusive with ``--db`` — passing both is a usage error
       (exit 2). Under ``--workspace`` mode with ``must_exist``, a missing
       ``index.db`` exits with code 3 and a fact-stating stderr message;
       consumers map the code to whatever recovery prompt they surface.
    2. Explicit ``--db`` flag.
    3. Walk-up auto-discovery via ``find_db``.

    Raises ``click.UsageError`` (exit 2) for cases 2 and 3 when no DB is
    found and ``must_exist`` is set.
    """
    ctx = click.get_current_context(silent=True)
    workspace_db = (ctx.obj or {}).get("workspace_db") if ctx and ctx.obj else None

    if workspace_db is not None:
        if db_path is not None:
            raise click.UsageError("--workspace and --db are mutually exclusive.")
        if must_exist and not Path(workspace_db).exists():
            click.echo(f"No OpenTrace index found at {workspace_db}", err=True)
            ctx.exit(EXIT_DB_MISSING)
        return workspace_db

    if db_path is not None:
        p = Path(db_path)
        if must_exist and not p.exists():
            raise click.UsageError(f"Database not found: {db_path}")
        return str(p)

    found = find_db()
    if found is not None:
        return str(found)

    if must_exist:
        raise click.UsageError(
            f"No {OPENTRACE_DIR}/{DB_NAME} found. Run 'opentraceai index' first or pass --db explicitly."
        )

    # Default for index (write) — create in cwd.
    return str(Path.cwd() / OPENTRACE_DIR / DB_NAME)


_GITIGNORE_CONTENT = """\
# OpenTrace index data — generated by `opentraceai index`
*.db
*.db.wal
*.indexlock
"""


def _ensure_gitignore(directory: Path) -> None:
    """Create or backfill ``.gitignore`` so older workspaces pick up new patterns."""
    gi = directory / ".gitignore"
    if not gi.exists():
        gi.write_text(_GITIGNORE_CONTENT)
        return

    existing = gi.read_text()
    existing_lines = set(existing.splitlines())
    missing = [
        line
        for line in _GITIGNORE_CONTENT.splitlines()
        if line and not line.startswith("#") and line not in existing_lines
    ]
    if not missing:
        return

    sep = "" if existing.endswith("\n") else "\n"
    gi.write_text(existing + sep + "\n".join(missing) + "\n")


@click.group(invoke_without_command=True)
@click.version_option(package_name="opentraceai")
@click.option(
    "--workspace",
    "workspace_dir",
    default=None,
    type=click.Path(),
    help=(
        "Resolve a workspace-scoped DB under ~/.opentrace/workspaces/, keyed "
        "by the resolved path of <dir>. Mutually exclusive with --db."
    ),
)
@click.pass_context
def app(ctx: click.Context, workspace_dir: str | None) -> None:
    """OpenTrace — map codebases into a knowledge graph."""
    ctx.ensure_object(dict)
    if workspace_dir is not None:
        try:
            db_path = resolve_workspace_db(workspace_dir)
        except (FileNotFoundError, OSError):
            click.echo(
                f"Workspace directory does not exist or is not accessible: {workspace_dir}",
                err=True,
            )
            ctx.exit(EXIT_WORKSPACE_UNRESOLVABLE)
        ctx.obj["workspace_db"] = str(db_path)
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


# Register the wiki subgroup. Imported here (after `app` is defined) so the
# subgroup module can stay independent of the rest of the CLI.
from opentrace_agent.cli.vault_cmd import vault as _vault_group  # noqa: E402

app.add_command(_vault_group)


def _safe_unlink(path_str: str, *, context: str) -> bool:
    """Unlink *path_str*, tolerating both missing files and permission errors.

    Returns True if a file was actually removed. Missing files are a no-op
    and return False. Permission or filesystem errors emit a stderr warning
    (tagged with *context* so the reader can tell which cleanup site logged
    it) and return False — they never propagate, so a doomed unlink can't
    crash a command that has otherwise succeeded or mask an unrelated
    exception that's already in flight.
    """
    path = Path(path_str)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as e:
        click.echo(
            f"Warning: failed to remove {path_str} ({context}): {e}",
            err=True,
        )
        return False


def _clean_stale_staging(staging_db: str) -> None:
    """Remove staging DB artifacts left by an interrupted prior ``index`` run.

    ``opentrace index`` writes to ``<db>.staging`` and atomically renames
    over ``<db>`` on success. If the writer is killed mid-run (SIGKILL,
    OOM, power loss), the staging file and its WAL are left on disk and
    cause the native DB layer to crash when the next run tries to reopen
    them. This helper runs at the top of the ``index`` write path; any
    pre-existing staging files are by definition orphaned and safe to
    remove under the single-writer assumption (only ``opentrace index``
    creates these files, and this process is about to become the writer).
    """
    removed: list[str] = []
    for path_str in (staging_db, staging_db + ".wal"):
        if _safe_unlink(path_str, context="stale staging"):
            removed.append(path_str)
    if removed:
        click.echo("Cleaned stale staging file(s) from a prior interrupted run:\n  " + "\n  ".join(removed))


def _seed_staging_from_live(db_path: str, staging_db: str) -> None:
    """Clone live DB + WAL into staging so a new index appends rather than replaces."""
    live = Path(db_path)
    if not live.exists():
        return

    shutil.copy2(live, staging_db)
    live_wal = Path(db_path + ".wal")
    if live_wal.exists():
        shutil.copy2(live_wal, staging_db + ".wal")


class _IndexLockError(click.ClickException):
    exit_code = EXIT_INDEX_IN_PROGRESS


def _acquire_index_lock(db_path: str):
    """Acquire an exclusive flock; caller must keep the returned handle alive."""
    try:
        import fcntl
    except ModuleNotFoundError:
        raise click.ClickException(
            "Indexing requires POSIX file locking (fcntl), which is not "
            "available on Windows. Run the agent under WSL or a POSIX shell."
        )

    lock_path = db_path + ".indexlock"
    fh = open(lock_path, "a")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        raise _IndexLockError(
            f"Another index is in progress against {db_path} "
            f"(lock held at {lock_path}). Wait for it to finish, or "
            f"remove the lock file if no index is actually running."
        )
    return fh


def _release_index_lock(fh) -> None:
    # Runs in a finally block; never raise — would shadow the pipeline's exception.
    try:
        import fcntl

        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    except ModuleNotFoundError:
        pass
    except OSError as e:
        if e.errno != errno.EBADF:
            click.echo(
                f"Warning: failed to release index lock: {e}",
                err=True,
            )
    try:
        fh.close()
    except OSError as e:
        click.echo(
            f"Warning: failed to close index lock handle: {e}",
            err=True,
        )


def _swap_staging_into_place(staging_db: str, db_path: str) -> None:
    """Rename staging → live, then reconcile the WAL pair.

    Two sequenced renames; there is a sub-ms window between them where a
    reader can see new DB + old WAL. A leftover live WAL with no staging
    WAL would corrupt the next read, so we drop it.
    """
    os.replace(staging_db, db_path)

    staging_wal = staging_db + ".wal"
    live_wal = db_path + ".wal"
    if Path(staging_wal).exists():
        try:
            os.replace(staging_wal, live_wal)
        except OSError as e:
            # Drop both rather than leave a torn pair; LadybugDB rebuilds the WAL on next open.
            click.echo(
                f"Warning: failed to install staging WAL ({e}); removing instead.",
                err=True,
            )
            _safe_unlink(staging_wal, context="post-rename cleanup")
            _safe_unlink(live_wal, context="post-rename cleanup")
    else:
        _safe_unlink(live_wal, context="post-rename cleanup")


def _run_indexing_pipeline(
    *,
    source_path: Path,
    repo_id: str,
    db_path: str,
    batch_size: int,
    verbose: bool,
    extra_metadata: dict[str, object] | None = None,
    wiki: bool = False,
    vault_name: str | None = None,
    vault_scope: str = "local",
    no_prune: bool = False,
    exclude_design_history: bool = False,
    on_event: "Callable[[object], None] | None" = None,
) -> float:
    """Run the four-stage pipeline with atomic-write staging.

    Writes to ``<db_path>.staging`` (seeded from the live DB so prior repos are
    preserved) and atomically renames over ``<db_path>`` on success. Holds an
    exclusive flock on ``<db>.indexlock`` so two concurrent indexes can't race
    the swap. *extra_metadata* is merged on top of the auto-collected metadata
    before persistence. Returns elapsed seconds.

    ``on_event`` (optional): invoked for every PipelineEvent yielded by the
    inner pipeline. Used by the serve.py /api/index-url worker to publish
    live progress (phase / current / total / nodes / edges) so the UI's
    polling endpoint can report meaningful numbers instead of zeros.
    Exceptions raised in the callback are swallowed — observability must
    never crash the pipeline.
    """
    from opentrace_agent.pipeline import PipelineInput, run_pipeline
    from opentrace_agent.pipeline.adapters import GraphStoreAdapter
    from opentrace_agent.store import GraphStore

    db_dir = Path(db_path).parent
    db_dir.mkdir(parents=True, exist_ok=True)
    _ensure_gitignore(db_dir)

    # Staging file avoids contending with readers (MCP) holding the live DB lock.
    staging_db = db_path + ".staging"

    lock_fh = _acquire_index_lock(db_path)
    try:
        _clean_stale_staging(staging_db)

        click.echo(f"Opening staging database at {staging_db} ...")
        try:
            _seed_staging_from_live(db_path, staging_db)

            with GraphStore(staging_db) as graph_store:
                store = GraphStoreAdapter(graph_store, batch_size=batch_size)

                click.echo(f"Indexing {source_path} ...")
                t0 = time.monotonic()

                inp = PipelineInput(
                    path=str(source_path),
                    repo_id=repo_id,
                    db_path=staging_db,
                )

                last_result = None
                for event in run_pipeline(inp, store=store):
                    _print_event(event, verbose)
                    if getattr(event, "result", None) is not None:
                        last_result = event.result
                    if on_event is not None:
                        try:
                            on_event(event)
                        except Exception:
                            logging.getLogger(__name__).debug("on_event callback raised; ignoring", exc_info=True)

                store.flush()

                # --- Phase 3: unified doc ingestion when --wiki is set ---
                # The code pipeline above is code-only now. The wiki doc pass
                # reads the doc files into SourceInputs and, in ONE LLM call per
                # doc, produces the KnowledgeDoc labels — into the same staging
                # DB, so the atomic swap covers code and docs together.
                # Nothing is synthesized.
                if wiki:
                    _run_wiki_compile_against_index(
                        graph_store=graph_store,
                        source_path=source_path,
                        vault_name=vault_name or _default_vault_name(source_path),
                        vault_scope=vault_scope,
                        repo_id=repo_id,
                        exclude_design_history=exclude_design_history,
                        verbose=verbose,
                    )

                # --- Phase 4: autoprune orphan documents ---
                # Sweep state for files that disappeared between this run
                # and the previous one. Scoped to the walked path / vault
                # so partial indexes don't blast away other repos' data.
                if wiki and not no_prune:
                    _run_autoprune_after_index(
                        graph_store=graph_store,
                        source_path=source_path,
                        vault_name=vault_name,
                        db_path=staging_db,
                        verbose=verbose,
                    )

                # Capture elapsed *after* every phase so metadata and the
                # "Done in N.Ns" line reflect actual wall-clock time —
                # wiki compile + autoprune + refresh dominate the runtime
                # when LLM flags are set.
                elapsed = time.monotonic() - t0

                metadata = _collect_metadata(source_path, repo_id, elapsed, last_result)
                if extra_metadata:
                    metadata.update(extra_metadata)
                graph_store.save_metadata(metadata)

            # Inside the try so a swap-time failure (ENOSPC, permission flip)
            # gets the same staging cleanup as a pipeline failure.
            _swap_staging_into_place(staging_db, db_path)
        except BaseException:
            _safe_unlink(staging_db, context="failed-index cleanup")
            _safe_unlink(staging_db + ".wal", context="failed-index cleanup")
            raise

        return elapsed
    finally:
        _release_index_lock(lock_fh)


@app.command()
@click.argument("path", default=".", type=str)
@click.argument("vault_name", required=False, default=None)
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help=f"Database path (default: ./{OPENTRACE_DIR}/{DB_NAME}).",
)
@click.option("--repo-id", default=None, help="Repository ID (defaults to directory name).")
@click.option("--batch-size", default=200, show_default=True, help="Items per batch.")
@click.option(
    "--wiki",
    "wiki_flag",
    is_flag=True,
    help=(
        "Ingest doc files (PDF/DOCX/MD/HTML/...) alongside code: ONE LLM call "
        "per doc produces the KnowledgeDoc's navigation label (title + "
        "one-line summary); docs are linked to their File twins "
        "(MIRRORS), to each other by the authors' own relative links "
        "(LINKS_TO), and stamped with an epistemic status (authoritative vs "
        "design_history). Doc bodies are kept verbatim in the corpus and read "
        "back via ``load_source`` — nothing is rewritten. The vault name "
        "defaults to the path basename; pass it as a second positional to "
        "override (e.g. ``index ./papers research``). Requires a configured "
        "LLM key — fails fast if missing. Plain ``index`` (no --wiki) stays "
        "code-only."
    ),
)
@click.option(
    "--global",
    "global_scope",
    is_flag=True,
    help=(
        "Compile the vault into the user-global root (~/.opentrace/vaults/ "
        "or $OT_VAULT_ROOT) instead of the project-local "
        "<cwd>/.opentrace/vaults/. Global vaults can be attached to any "
        "graph via ``opentraceai vault attach``. Only meaningful with "
        "--wiki."
    ),
)
@click.option(
    "--no-prune",
    is_flag=True,
    help=(
        "Skip autoprune on re-runs. By default, ``index --wiki`` removes graph "
        "state for sources that disappeared from disk between runs "
        "(scope-limited to the walked path / vault); this flag preserves "
        "orphans for inspection."
    ),
)
@click.option(
    "--wiki-exclude-design-history",
    "exclude_design_history",
    is_flag=True,
    help=(
        "Skip design-history docs (openspec/ADR/RFC/proposal trees, "
        "CHANGELOGs) during --wiki ingestion instead of compiling them with "
        "a design-history status label. Use when a repo's design record "
        "drowns out its real documentation."
    ),
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def index(
    path: str,
    db_path: str | None,
    repo_id: str | None,
    batch_size: int,
    wiki_flag: bool,
    vault_name: str | None,
    global_scope: bool,
    no_prune: bool,
    exclude_design_history: bool,
    verbose: bool,
) -> None:
    """Index a local codebase into a LadybugDB knowledge graph."""
    _configure_logging(verbose)

    # A vault-name positional implies doc ingestion (--wiki).
    wiki = wiki_flag or vault_name is not None

    if exclude_design_history and not wiki:
        raise click.ClickException("--wiki-exclude-design-history requires --wiki (or a vault name).")

    # Preflight: doc ingestion needs an LLM backend. Detect now so we fail
    # before opening the staging DB / acquiring locks, rather than mid-pipeline.
    if wiki:
        from opentrace_agent.sources._llm_common import actionable_no_backend_message
        from opentrace_agent.sources.markdown.clients import detect_client

        if detect_client() is None:
            raise click.ClickException(actionable_no_backend_message())

    # Classify the input shape. URLs and single files take a different path —
    # they skip the directory walker and feed one SourceInput straight to the
    # extract/wiki pipelines. Only a directory makes sense for the full code
    # walk (Repository/Directory/File nodes).
    input_kind = _classify_index_input(path)

    if input_kind in ("url", "file"):
        if not wiki:
            raise click.ClickException(f"Single-{input_kind} input requires --wiki (there's no code to walk).")
        resolved_db = _resolve_db(db_path)
        resolved_vault = vault_name or _default_vault_name_for_uri(path, input_kind)
        elapsed = _run_single_source_pipeline(
            uri=path,
            kind=input_kind,
            db_path=resolved_db,
            verbose=verbose,
            vault_name=resolved_vault,
            vault_scope="global" if global_scope else "local",
        )
        click.echo(f"Done in {elapsed:.1f}s.")
        return

    # Directory path: existing flow.
    root = Path(path).resolve()
    if not root.is_dir():
        raise click.ClickException(f"Path does not exist or is not a directory: {path}")
    if repo_id is None:
        repo_id = root.name

    resolved_db = _resolve_db(db_path)
    resolved_vault = vault_name or _default_vault_name(root)

    elapsed = _run_indexing_pipeline(
        source_path=root,
        repo_id=repo_id,
        db_path=resolved_db,
        batch_size=batch_size,
        verbose=verbose,
        wiki=wiki,
        vault_name=resolved_vault,
        vault_scope="global" if global_scope else "local",
        no_prune=no_prune,
        exclude_design_history=exclude_design_history,
    )

    click.echo(f"Done in {elapsed:.1f}s.")


def _run_autoprune_after_index(
    *,
    graph_store,
    source_path: Path,
    vault_name: str | None,
    db_path: str,
    verbose: bool,
) -> None:
    """Re-walk the source path, compute walked shas, then run autoprune.

    Re-walks are cheap (no LLM, just filesystem traversal) and keep the
    autoprune logic decoupled from the pipeline event stream. We use the
    same DirectoryWalker classification the index pipeline used so the
    walked set is consistent.
    """
    from opentrace_agent.pipeline.autoprune import (
        autoprune_after_index,
        compute_walked_shas,
    )
    from opentrace_agent.sources.code.directory_walker import (
        DOC_EXTENSIONS,
        EXCLUDED_DIRS,
    )

    walked_docs: list[Path] = []

    if source_path.is_file():
        if source_path.suffix.lower() in DOC_EXTENSIONS:
            walked_docs.append(source_path)
    else:
        for dirpath, dirnames, filenames in os.walk(source_path):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS and not d.endswith(".egg-info")]
            for filename in sorted(filenames):
                ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
                if ext in DOC_EXTENSIONS:
                    walked_docs.append(Path(dirpath) / filename)

    walked_shas = compute_walked_shas(walked_docs)

    report = autoprune_after_index(
        graph_store,
        walked_doc_shas=walked_shas,
        vault_name=vault_name,
        scope_path=source_path,
        db_path=db_path,
    )

    if report.sources_deleted or report.corpus_files_deleted:
        click.echo(
            f"  Autoprune: -{report.sources_deleted} documents, "
            f"-{report.corpus_files_deleted} corpus files"
        )
    elif verbose:
        click.echo("  Autoprune: no orphans found.")


def _find_repo_vault(repo_id: str, *, scope: str, project_root: Path) -> str | None:
    """Name of a vault in *scope* previously spawned from *repo_id*, or None.

    Reads each on-disk vault's ``.vault.json`` ``spawned_from`` — the stable
    repo→vault key that makes re-indexing idempotent (see
    :func:`_resolve_index_vault_name`).
    """
    from opentrace_agent.wiki.paths import list_vaults, metadata_path
    from opentrace_agent.wiki.vault import load_metadata

    for name in list_vaults(scope=scope, project_root=project_root):  # type: ignore[arg-type]
        try:
            meta = load_metadata(metadata_path(name, scope=scope, project_root=project_root), name=name)  # type: ignore[arg-type]
        except (OSError, ValueError):
            continue
        if meta.spawned_from == repo_id:
            return name
    return None


def _resolve_index_vault_name(
    vault_name: str,
    *,
    scope: str,
    project_root: Path,
    repo_id: str | None,
) -> str:
    """Pick the vault name an ``index --wiki`` run should write to.

    1. **Re-index** — if *repo_id* already owns a vault in *scope* (matched by
       ``spawned_from``), reuse that vault's name so the run updates it in
       place. This is stable even when the name was auto-suffixed on first
       creation, so re-runs don't pile up ``flask-1``, ``flask-2``, ….
    2. **Adopt same-name** — a vault of this exact name already lives in
       *scope* (e.g. one compiled before ``spawned_from`` tracking): update it,
       matching the historical append-on-same-name behaviour.
    3. **New vault** — mint a name free in *both* scopes so a local and global
       vault never share a label.
    """
    from opentrace_agent.wiki.paths import resolve_vault_scope, unique_vault_name

    if repo_id is not None:
        owned = _find_repo_vault(repo_id, scope=scope, project_root=project_root)
        if owned is not None:
            return owned
    existing = resolve_vault_scope(vault_name, prefer=scope, project_root=project_root)  # type: ignore[arg-type]
    if existing is not None and existing[0] == scope:
        return vault_name
    return unique_vault_name(vault_name, project_root=project_root)


def _collect_wiki_inputs(
    source_path: Path,
    *,
    exclude_design_history: bool = False,
    status_override: str | None = None,
    extensions: frozenset[str] | None = None,
) -> list["SourceInput"]:
    """Walk *source_path* for doc files and build SourceInputs, stamping each
    with its epistemic status (``classify_doc_status``). Directories excluded
    from the code walk are excluded here too. With *exclude_design_history*,
    design-history docs (proposal/spec/ADR trees, CHANGELOGs) are dropped
    instead of typed. *status_override* replaces the heuristic status on every
    surviving input (exclusion still uses the heuristic, so combining the two
    means "drop the ADR trees, force the rest"). *extensions* overrides the
    walked extension set (default ``DOC_EXTENSIONS``); ``vault ingest`` passes
    a wider set — if you change it there, change the prune walk with it."""
    from opentrace_agent.sources.code.directory_walker import (
        DOC_EXTENSIONS,
        EXCLUDED_DIRS,
    )
    from opentrace_agent.wiki import SourceInput
    from opentrace_agent.wiki.ingest.sources import classify_doc_status

    if extensions is None:
        extensions = DOC_EXTENSIONS
    inputs: list[SourceInput] = []
    if source_path.is_file():
        if source_path.suffix.lower() in extensions:
            inputs.append(
                SourceInput(
                    name=source_path.name,
                    data=source_path.read_bytes(),
                    status=status_override or "authoritative",
                )
            )
        return inputs
    for dirpath, dirnames, filenames in os.walk(source_path):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS and not d.endswith(".egg-info")]
        for filename in sorted(filenames):
            ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            if ext not in extensions:
                continue
            abs_file = Path(dirpath) / filename
            # Pass the path RELATIVE to the walked root, not the bare
            # basename — corpora routinely repeat filenames across folders
            # (every package dir has a README.md / index.md). The relative
            # path lets the summariser disambiguate otherwise-identical doc
            # titles, and gives each KnowledgeDoc a root-relative ``path``.
            rel_name = os.path.relpath(abs_file, source_path)
            status = classify_doc_status(rel_name)
            if exclude_design_history and status != "authoritative":
                continue
            status = status_override or status
            try:
                inputs.append(SourceInput(name=rel_name, data=abs_file.read_bytes(), status=status))
            except OSError as exc:
                click.echo(f"  Skipped {rel_name}: {exc}", err=True)
    return inputs


# Token assumptions behind every doc-ingestion cost estimate. Input is a rough
# average document; output is one sentence, which is all the extraction schema
# asks for since concepts and entities were removed. Keep these two together so
# the second-guessing happens in one place.
INPUT_TOKENS_PER_DOC = 4_000
OUTPUT_TOKENS_PER_DOC = 100

def _echo_wiki_cost_estimate(
    provider: str,
    inputs: list["SourceInput"],
    *,
    indent: str = "    ",
) -> None:
    """Pre-flight per-extension breakdown + cost estimate for a doc ingestion.

    The extension breakdown prints first so a folder full of image attachments
    is visible as "84 × .png" BEFORE the money is spent.

    The doc pass is ONE call per source emitting ONE field (the one-line
    summary), and it runs on the backend's extraction tier — so the estimate
    must use that tier's pricing, not the flagship pair. Getting either wrong
    is not cosmetic: this line exists so someone can decide whether to spend,
    and it previously overstated a 48-doc ingest at ~$1.30 against an actual
    ~$0.20 — flagship rates (~3x) on top of a 1k-output assumption left over
    from when this call also emitted concepts and an entity graph (~20x on the
    output half).

    Cost is now dominated by INPUT — the unavoidable cost of the model reading
    each document once. If a field is ever added back to the extraction schema,
    revisit OUTPUT_TOKENS_PER_DOC with it.
    """
    from collections import Counter

    from opentrace_agent.sources._llm_common import extraction_pricing

    counts = Counter(Path(inp.name).suffix.lower() or "(no ext)" for inp in inputs)
    breakdown = ", ".join(f"{n} × {ext}" for ext, n in counts.most_common())
    click.echo(f"{indent}{breakdown}")

    pricing = extraction_pricing(provider)
    if pricing is None:
        return
    price_in, price_out = pricing
    est_calls = len(inputs)
    est_cost = (
        est_calls * INPUT_TOKENS_PER_DOC / 1_000_000 * price_in
        + est_calls * OUTPUT_TOKENS_PER_DOC / 1_000_000 * price_out
    )
    click.echo(f"{indent}via {provider} (~${est_cost:.2f} estimated)")


def _echo_llm_actuals(event, provider: str, indent: str = "    ") -> None:
    """Print billed-token actuals from a DONE event, when the run made LLM calls.

    The counterpart to :func:`_echo_wiki_cost_estimate`: the estimate prints
    before spending, this prints what was actually billed after — so a stale
    estimate assumption is contradicted on the very next run rather than
    surviving until someone re-derives the arithmetic by hand.
    """
    usage = (event.detail or {}).get("llm_usage")
    if not usage:
        return
    from opentrace_agent.sources._llm_common import extraction_pricing

    pricing = extraction_pricing(provider)
    cost_note = ""
    if pricing is not None:
        actual = usage["input_tokens"] / 1_000_000 * pricing[0] + usage["output_tokens"] / 1_000_000 * pricing[1]
        cost_note = f" · ~${actual:.2f} billed"
    click.echo(
        f"{indent}llm actuals: {usage['input_tokens']:,} in / {usage['output_tokens']:,} out "
        f"across {usage['calls']} call(s){cost_note}"
    )


def _run_wiki_compile_against_index(
    *,
    graph_store,
    source_path: Path,
    vault_name: str,
    vault_scope: str = "local",
    repo_id: str | None = None,
    exclude_design_history: bool = False,
    verbose: bool,
) -> None:
    """Run the wiki doc-ingestion pipeline against doc files under *source_path*.

    Reuses the DirectoryWalker's DOC_EXTENSIONS classification to discover
    the doc files, builds them into
    ``SourceInput`` objects, and feeds them to ``wiki.ingest.pipeline.
    run_compile`` against the given vault. ``graph_store`` is the staging
    DB the index pipeline is already writing to — the wiki pipeline
    mirrors its output into the same store.

    LLM autodetect mirrors ``cli/vault_cmd._autodetect_provider`` (hard-fail
    when no key set, anthropic→gemini→openai priority).

    When *repo_id* is set (directory index), every ingested doc gets a
    ``KnowledgeDoc -MIRRORS-> File`` edge plus a ``path`` stamp, bridging the
    corpus layer and the code tree. Docs whose extension the code walk skips
    (.rst/.txt/.html/PDFs) get their File node created at link time. The
    authors' own relative links between docs become ``LINKS_TO`` edges in the
    same pass.

    """
    from opentrace_agent.cli.vault_cmd import _autodetect_provider
    from opentrace_agent.wiki import run_compile

    # Collect doc files via the same classification the walker uses.
    inputs = _collect_wiki_inputs(source_path, exclude_design_history=exclude_design_history)

    if not inputs:
        click.echo(f"  --wiki: no doc files found under {source_path}.")
        return

    # Vault must live next to the index DB (so a single `.opentrace/`
    # dir holds both the graph and its vaults), not nested inside the
    # walked source path. db_path looks like `<root>/.opentrace/index.db`
    # (or its `.staging` sibling) — strip two levels to get the project root.
    db_path = Path(graph_store.db_path)
    project_root = db_path.parent.parent

    # Resolve the target vault name: reuse the vault this repo produced on a
    # previous run (so a re-index updates it in place — even if its name was
    # auto-suffixed to dodge a collision), otherwise mint a name that doesn't
    # clash with any existing vault in either scope.
    vault_name = _resolve_index_vault_name(vault_name, scope=vault_scope, project_root=project_root, repo_id=repo_id)

    scope_label = "global" if vault_scope == "global" else "local"
    click.echo(f"  --wiki: ingesting {len(inputs)} doc(s) into {scope_label} vault {vault_name!r} ...")

    provider = _autodetect_provider()

    _echo_wiki_cost_estimate(provider, inputs)

    from opentrace_agent.wiki.ingest.types import WikiEventKind, WikiPhase

    # Stages whose per-unit progress is worth showing by default — the
    # LLM-bound ones the user is actually waiting on. Cheap stages (hashing,
    # normalizing) stay --verbose-only so they don't spam the output.
    _progress_phases = {WikiPhase.EXTRACTING}

    # Globals are disk-only at compile time — attach them to a project's
    # graph via ``opentraceai vault attach`` (or the UI's Global-tab "+"
    # button). Mirroring at compile time would assume "the project that
    # created this vault wants it indexed here", which isn't always true.
    mirror_target = graph_store if vault_scope == "local" else None
    for event in run_compile(
        vault_name=vault_name,
        inputs=inputs,
        provider=provider,
        scope=vault_scope,
        project_root=project_root,
        graph_store=mirror_target,
    ):
        # Stage boundaries + completion + errors always print so users can see
        # the wiki phase progressing. Per-unit progress prints for the slow
        # LLM stages by default (with an [n/total] counter); cheap stages
        # stay --verbose-only.
        if event.kind in (
            WikiEventKind.STAGE_START,
            WikiEventKind.STAGE_STOP,
            WikiEventKind.DONE,
        ):
            click.echo(f"    wiki: {event.message}")
            if event.kind == WikiEventKind.DONE:
                _echo_llm_actuals(event, provider)
        elif event.kind == WikiEventKind.ERROR:
            click.echo(f"    wiki ERROR: {event.message}", err=True)
        elif event.kind == WikiEventKind.STAGE_PROGRESS and (verbose or event.phase in _progress_phases):
            counter = f"[{event.current}/{event.total}] " if event.total else ""
            click.echo(f"    wiki: {counter}{event.message}")

    # Bridge the wiki layer to the code tree. Repo-walked runs only (repo_id
    # set + a graph mirror): single-file / URL / global-vault compiles have
    # neither a repo nor File twins — nothing to link.
    if repo_id is not None and mirror_target is not None:
        from opentrace_agent.wiki.ingest.graph_writer import (
            link_corpus_doc_mirrors,
            link_doc_to_doc_links,
            link_vault_to_repo,
        )

        named_blobs = [(inp.name, inp.data) for inp in inputs]

        # Every ingested doc gets a MIRRORS edge to its File twin + path stamp.
        linked = link_corpus_doc_mirrors(mirror_target, repo_id, named_blobs)
        if linked:
            click.echo(f"    wiki: linked {linked} doc(s) to their File nodes (MIRRORS)")

        # The authors' own cross-references between docs — markdown relative
        # links parsed mechanically into KnowledgeDoc -LINKS_TO-> KnowledgeDoc,
        # the doc-side analogue of the code graph's import edges.
        doc_links = link_doc_to_doc_links(mirror_target, named_blobs)
        if doc_links:
            click.echo(f"    wiki: linked {doc_links} doc-to-doc reference(s) (LINKS_TO)")

        # The vault itself spawned from this repo — record that as a
        # Repository -DOCUMENTS-> Vault edge + spawned_from stamp.
        # This is the ONLY path that writes it: attached globals and
        # dropped-file compiles don't document the repo they sit next to.
        if link_vault_to_repo(mirror_target, repo_id, vault_name):
            click.echo(f"    wiki: linked vault {vault_name!r} to repository {repo_id!r} (DOCUMENTS)")

    # Persist the repo→vault link on disk (both scopes, graph or not) so a
    # future re-index reuses this vault instead of minting a new suffixed one.
    if repo_id is not None:
        from opentrace_agent.wiki.paths import metadata_path
        from opentrace_agent.wiki.vault import load_metadata, save_metadata

        mp = metadata_path(vault_name, scope=vault_scope, project_root=project_root)  # type: ignore[arg-type]
        try:
            meta = load_metadata(mp, name=vault_name)
            if meta.spawned_from != repo_id:
                meta.spawned_from = repo_id
                save_metadata(mp, meta)
        except OSError as exc:
            click.echo(f"  --wiki: could not stamp spawned_from on {vault_name!r}: {exc}", err=True)


def _default_vault_name(path: Path) -> str:
    """Derive a vault name from an input path.

    - Git repo (.git/ walks up): the basename of the repo root
    - Plain folder: ``path.name``
    - Single file: ``path.stem``
    - URL: handled separately in the CLI (caller slugifies the URL path)

    Falls back to ``path.name`` when classification is ambiguous.
    Always run through ``wiki.slugify.base_slug`` so the result is
    filesystem-safe.
    """
    from opentrace_agent.wiki.slugify import base_slug

    if path.is_file():
        candidate = path.stem
    else:
        # Walk up for a git root — index typically points at the repo
        # itself, but sometimes a subdirectory. Walking up gives the
        # natural project name when that happens.
        try:
            import git

            repo = git.Repo(path, search_parent_directories=True)
            repo_root = Path(repo.working_tree_dir or path).name
            candidate = repo_root or path.name
        except Exception:
            candidate = path.name

    slug = base_slug(candidate or "default")
    return slug or "default"


def _classify_index_input(path: str) -> str:
    """Return ``"url"`` / ``"file"`` / ``"dir"`` for an ``index`` argument.

    URLs are detected by scheme. Local paths must exist; a non-existent path
    raises so the caller surfaces a clear error before pipeline setup.
    """
    from opentrace_agent.sources.markdown.fetchers import is_url

    if is_url(path):
        return "url"
    p = Path(path)
    if p.is_dir():
        return "dir"
    if p.is_file():
        return "file"
    raise click.ClickException(f"Path does not exist: {path}")


def _default_vault_name_for_uri(uri: str, kind: str) -> str:
    """Vault name fallback for URL / single-file inputs (slugified)."""
    from opentrace_agent.sources.markdown.fetchers import url_basename
    from opentrace_agent.wiki.slugify import base_slug

    if kind == "url":
        candidate = Path(url_basename(uri)).stem or "url"
    else:
        candidate = Path(uri).stem or "default"
    return base_slug(candidate) or "default"


def _run_single_source_pipeline(
    *,
    uri: str,
    kind: str,
    db_path: str,
    verbose: bool,
    vault_name: str,
    vault_scope: str = "local",
) -> float:
    """Index a single URL or local file as one SourceInput.

    Skips the DirectoryWalker (no Repository/Directory/File nodes). Builds a
    SourceInput from raw bytes and runs the unified wiki doc pass against it
    (one LLM call → the one-line summary), persists into the
    staging DB, and atomically swaps. Returns elapsed seconds.

    Autoprune intentionally doesn't run here — single-source ingest doesn't
    have a "walked set" to compute orphans against.
    """
    from opentrace_agent.sources.markdown.fetchers import (
        UnsupportedSourceError,
        fetch_bytes,
        resolve,
        url_basename,
    )
    from opentrace_agent.store import GraphStore
    from opentrace_agent.wiki import SourceInput, run_compile

    db_dir = Path(db_path).parent
    db_dir.mkdir(parents=True, exist_ok=True)
    _ensure_gitignore(db_dir)

    staging_db = db_path + ".staging"

    # Fetch raw bytes (so we can content-address the Source by sha) and
    # decide what URI to hand markitdown for conversion.
    if kind == "url":
        try:
            markitdown_uri = resolve(uri)
        except UnsupportedSourceError as e:
            raise click.ClickException(str(e))
        click.echo(f"Fetching {markitdown_uri} ...")
        try:
            raw_bytes = fetch_bytes(markitdown_uri)
        except Exception as e:  # noqa: BLE001
            raise click.ClickException(f"failed to fetch {markitdown_uri}: {e}")
        display_name = url_basename(markitdown_uri)
        source_uri = uri  # user-facing URL, stamped on run metadata
    else:
        local = Path(uri).resolve()
        raw_bytes = local.read_bytes()
        display_name = local.name
        source_uri = str(local)

    lock_fh = _acquire_index_lock(db_path)
    try:
        _clean_stale_staging(staging_db)
        click.echo(f"Opening staging database at {staging_db} ...")
        try:
            _seed_staging_from_live(db_path, staging_db)
            with GraphStore(staging_db) as graph_store:
                t0 = time.monotonic()

                # One unified per-doc pass: the navigation label. The doc
                # body itself is kept verbatim in the corpus, so a lone doc
                # yields a labelled KnowledgeDoc and nothing else.
                project_root = Path(staging_db).parent.parent
                inputs = [SourceInput(name=display_name, data=raw_bytes)]
                click.echo(f"  --wiki: ingesting 1 doc into {vault_scope} vault {vault_name!r} ...")
                provider = _autodetect_provider_for_compile()

                # One implementation, not a second copy of the arithmetic — the
                # duplicate is exactly why this site was still pricing at
                # flagship rates with a 1k-output assumption.
                _echo_wiki_cost_estimate(provider, inputs)

                from opentrace_agent.wiki.ingest.types import WikiEventKind

                for event in run_compile(
                    vault_name=vault_name,
                    inputs=inputs,
                    provider=provider,
                    scope=vault_scope,
                    project_root=project_root,
                    graph_store=graph_store,
                ):
                    if event.kind in (
                        WikiEventKind.STAGE_START,
                        WikiEventKind.STAGE_STOP,
                        WikiEventKind.DONE,
                    ):
                        click.echo(f"    wiki: {event.message}")
                        if event.kind == WikiEventKind.DONE:
                            _echo_llm_actuals(event, provider)
                    elif event.kind == WikiEventKind.ERROR:
                        click.echo(f"    wiki ERROR: {event.message}", err=True)
                    elif verbose:
                        click.echo(f"    wiki: {event.message}")

                elapsed = time.monotonic() - t0
                # For URL inputs the source_uri isn't a meaningful filesystem
                # path; use the project dir as the metadata anchor instead so
                # gitpython probing doesn't trip over the URL string.
                meta_anchor = Path(db_path).resolve().parent.parent
                metadata = _collect_metadata(meta_anchor, None, elapsed, None)
                metadata["sourceUri"] = source_uri
                graph_store.save_metadata(metadata)

            _swap_staging_into_place(staging_db, db_path)
        except BaseException:
            _safe_unlink(staging_db, context="failed-index cleanup")
            _safe_unlink(staging_db + ".wal", context="failed-index cleanup")
            raise

        return elapsed
    finally:
        _release_index_lock(lock_fh)


def _autodetect_provider_for_compile() -> str:
    """Local alias around the vault command's autodetect — avoids the import cycle."""
    from opentrace_agent.cli.vault_cmd import _autodetect_provider

    return _autodetect_provider()


def _print_event(event: object, verbose: bool) -> None:
    """Print pipeline events to the terminal."""
    from opentrace_agent.pipeline import EventKind

    kind = getattr(event, "kind", None)
    message = getattr(event, "message", "")
    result = getattr(event, "result", None)

    if kind == EventKind.STAGE_START:
        click.echo(f"  {message}")
    elif kind == EventKind.STAGE_PROGRESS and (verbose or getattr(event, "important", False)):
        detail = getattr(event, "detail", None)
        if detail:
            click.echo(f"    [{detail.current}/{detail.total}] {message}")
        else:
            click.echo(f"    {message}")
    elif kind == EventKind.STAGE_STOP:
        click.echo(f"  {message}")
    elif kind == EventKind.DONE and result:
        click.echo(
            f"  {result.nodes_created} nodes, "
            f"{result.relationships_created} relationships, "
            f"{result.files_processed} files, "
            f"{result.classes_extracted} classes, "
            f"{result.functions_extracted} functions"
        )
    elif kind == EventKind.ERROR:
        errors = getattr(event, "errors", [])
        click.echo(f"  Error: {message}", err=True)
        for err in errors or []:
            click.echo(f"    {err}", err=True)


def _collect_metadata(root: Path, repo_id: str | None, elapsed: float, result: object | None) -> dict[str, object]:
    """Gather index metadata from the repo and pipeline result.

    Keys use camelCase column names matching the proto-generated IndexMetadata
    schema so both Python and TypeScript consumers see the same shape.
    """
    from datetime import datetime, timezone

    meta: dict[str, object] = {
        "indexedAt": datetime.now(timezone.utc).isoformat(),
        "durationSeconds": round(elapsed, 2),
        "repoId": repo_id,
        "repoPath": str(root),
        "opentraceaiVersion": _get_version(),
    }

    # Git info — best-effort, non-fatal.
    try:
        import git

        repo = git.Repo(root, search_parent_directories=True)
        head = repo.head.commit
        meta["commitSha"] = head.hexsha
        meta["commitMessage"] = head.message.strip().split("\n", 1)[0]
        meta["branch"] = repo.active_branch.name if not repo.head.is_detached else None
        # Remote URL — prefer 'origin', fall back to first remote.
        if repo.remotes:
            remote = repo.remotes["origin"] if "origin" in repo.remotes else repo.remotes[0]
            meta["sourceUri"] = remote.url
    except Exception:
        pass

    # Pipeline result stats.
    if result is not None:
        _ATTR_MAP = {
            "nodes_created": "nodesCreated",
            "relationships_created": "relationshipsCreated",
            "files_processed": "filesProcessed",
            "classes_extracted": "classesExtracted",
            "functions_extracted": "functionsExtracted",
        }
        for attr, key in _ATTR_MAP.items():
            val = getattr(result, attr, None)
            if val is not None:
                meta[key] = val

    return meta


def _get_version() -> str:
    """Return the installed opentraceai version."""
    try:
        from importlib.metadata import version

        return version("opentraceai")
    except Exception:
        return "unknown"


@app.command()
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
@click.option(
    "--output",
    "output_format",
    type=click.Choice(["text", "json"]),
    default="text",
    show_default=True,
    help="Output format.",
)
def stats(db_path: str | None, output_format: str) -> None:
    """Display graph statistics."""
    import json

    from opentrace_agent.store import GraphStore

    resolved_db = _resolve_db(db_path, must_exist=True)
    store = GraphStore(resolved_db, read_only=True)
    try:
        data = store.get_stats()
        metadata = store.get_metadata()
    finally:
        store.close()

    if metadata:
        data["metadata"] = metadata

    if output_format == "json":
        click.echo(json.dumps(data))
        return

    # text: compact, prompt-friendly format
    nodes_by_type = data.get("nodes_by_type", {})
    parts = [f"{count} {ntype}" for ntype, count in sorted(nodes_by_type.items(), key=lambda x: -x[1])]
    click.echo(f"{data['total_nodes']} nodes, {data['total_edges']} edges: {', '.join(parts)}")

    for entry in metadata:
        repo_id = entry.get("repoId", "")
        commit_sha = entry.get("commitSha", "")
        commit = commit_sha[:8] if commit_sha else ""
        branch = entry.get("branch", "")
        indexed_at = entry.get("indexedAt", "")
        duration = entry.get("durationSeconds", "")
        ref = f"{branch}@{commit}" if branch and commit else commit or branch
        parts = []
        if repo_id:
            parts.append(repo_id)
        if ref:
            parts.append(ref)
        if indexed_at:
            parts.append(indexed_at)
        if duration:
            parts.append(f"{duration}s")
        if parts:
            click.echo(f"  Indexed: {', '.join(parts)}")


class _ReloadableStore:
    """Transparent proxy for GraphStore that reopens when the DB file is replaced.

    LadybugDB uses exclusive file locking, so a long-running reader (MCP)
    blocks writers (``opentrace index``).  The indexer works around this by
    writing to a staging file and atomically renaming it over the original.

    This proxy detects the rename (via inode change) and transparently
    reopens the database.  Attribute access is delegated to the inner
    store, so callers treat this as a regular ``GraphStore``.
    """

    def __init__(self, db_path: str | None, store: object | None) -> None:
        self._db_path = db_path
        self._store = store
        self._inode = self._stat_inode()
        self._lock = threading.Lock()
        self._log = logging.getLogger("opentrace_agent.mcp.reload")

    # -- inode helpers -------------------------------------------------------

    def _stat_inode(self) -> int | None:
        if self._db_path is None:
            return None
        try:
            return os.stat(self._db_path).st_ino
        except OSError:
            return None

    def _maybe_reload(self) -> None:
        """Reopen the database if the file's inode has changed.

        Thread-safe: FastMCP may dispatch tool calls from a thread pool.
        """
        if self._db_path is None:
            return

        with self._lock:
            current_inode = self._stat_inode()
            if current_inode == self._inode:
                return

            self._log.info(
                "Database file changed (inode %s → %s), reopening",
                self._inode,
                current_inode,
            )

            # Close the old store first.  LadybugDB associates a WAL file
            # with the open database; if we tried to open the new file
            # while the old store still holds its WAL open, the new open
            # would fail with a "Database ID does not match" error.
            if self._store is not None:
                try:
                    self._store.close()
                except Exception:
                    pass

            self._store = None
            self._inode = current_inode

            if current_inode is not None:
                from opentrace_agent.store import GraphStore

                try:
                    self._store = GraphStore(self._db_path, read_only=True)
                except Exception as e:
                    self._log.warning("Failed to reopen database: %s", e)

    # -- proxy protocol ------------------------------------------------------

    def __bool__(self) -> bool:
        self._maybe_reload()
        return self._store is not None

    def __getattr__(self, name: str) -> object:
        self._maybe_reload()
        store = self._store
        if store is None:
            raise AttributeError(name)
        return getattr(store, name)

    def close(self) -> None:
        with self._lock:
            if self._store is not None:
                self._store.close()
                self._store = None


@app.command("mcp")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def mcp_cmd(db_path: str | None, verbose: bool) -> None:
    """Start a stdio MCP server exposing graph query tools."""
    _configure_logging(verbose)
    log = logging.getLogger("opentrace_agent.mcp")

    log.debug("MCP server starting (pid=%d)", os.getpid())

    from opentrace_agent.cli.mcp_server import create_mcp_server
    from opentrace_agent.store import GraphStore

    store: GraphStore | None = None

    try:
        resolved_db = _resolve_db(db_path, must_exist=True)
    except click.UsageError:
        log.info("No index found — MCP server will start without a database")
        resolved_db = None

    if resolved_db is not None:
        log.debug("Opening database: %s", resolved_db)
        try:
            store = GraphStore(resolved_db, read_only=True)
        except Exception as e:
            log.warning("Failed to open database: %s — continuing without index", e)
            store = None

    if store is not None:
        stats = store.get_stats()
        log.debug(
            "Database ready: %d nodes, %d edges",
            stats["total_nodes"],
            stats["total_edges"],
        )

    reloadable = _ReloadableStore(resolved_db, store)

    def _shutdown(signum: int, _frame: object) -> None:
        log.debug("Received signal %d, shutting down", signum)
        reloadable.close()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _shutdown)

    try:
        server = create_mcp_server(reloadable)
        log.debug("MCP server running on stdio")
        server.run(transport="stdio")
    except KeyboardInterrupt:
        log.debug("Interrupted")
    except Exception as e:
        log.error("MCP server error: %s", e, exc_info=True)
        raise
    finally:
        reloadable.close()
        log.debug("MCP server stopped")


def _replay_db_journal(resolved_db: str) -> None:
    """Replay a LadybugDB write journal by opening the DB read-write once.

    Run in a SEPARATE process on purpose: real_ladybug segfaults if the same
    DB path is opened more than once within a single process, so `serve` (which
    must then open the DB read-only itself) can't do the replay in-process.
    Opening read-write replays the WAL / shadow pages and closing checkpoints
    them, clearing the ``.wal`` / ``.shadow`` files.
    """
    import subprocess
    import sys

    child = (
        "import sys, real_ladybug as lb\n"
        "db = lb.Database(sys.argv[1], read_only=False)\n"  # replays the journal
        "lb.Connection(db).execute('MATCH (n) RETURN count(n)').get_next()\n"
        "db.close()\n"  # checkpoints -> clears .wal / .shadow
    )
    result = subprocess.run(
        [sys.executable, "-c", child, resolved_db],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or "").strip()[-800:]
        raise click.ClickException(
            f"Could not recover the interrupted write journal for {resolved_db}. "
            "The graph may be corrupt — re-index to rebuild it "
            "(`opentraceai index <path>`).\n" + detail
        )


def _open_readonly_with_recovery(resolved_db: str) -> "GraphStore":
    """Open the graph DB read-only, self-healing an unreplayed write journal.

    `serve` opens read-only so multiple readers can share the file. If a prior
    writer (a local-vault compile or an index) was killed/crashed while holding
    the DB read-write, LadybugDB leaves ``.wal`` / ``.shadow`` journal files a
    read-only handle can't replay — the open fails with "re-open the database
    with read-write mode to replay shadow pages".

    Detect that via the journal files (not by trying a read-only open first:
    real_ladybug segfaults on a second open in the same process, so we must
    open here exactly once) and replay them in a subprocess before opening.
    """
    from opentrace_agent.store import GraphStore

    db = Path(resolved_db)
    journal_files = [db.with_name(db.name + ext) for ext in (".wal", ".shadow")]
    if any(f.exists() for f in journal_files):
        click.echo(
            "  Database has an unreplayed write journal — a previous compile or "
            "index was interrupted. Recovering it before serving…",
            err=True,
        )
        _replay_db_journal(resolved_db)

    return GraphStore(resolved_db, read_only=True)


@app.command()
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
@click.option("--host", default="127.0.0.1", show_default=True, help="Bind address.")
@click.option("--port", default=8787, show_default=True, help="Bind port.")
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def serve(db_path: str | None, host: str, port: int, verbose: bool) -> None:
    """Start an HTTP server exposing the graph database + vault routes.

    Provides a REST API that replaces the in-browser WASM LadybugDB engine,
    letting the UI query a server-backed graph. When no ``.opentrace/index.db``
    is found, an empty one is bootstrapped at ``<cwd>/.opentrace/index.db``
    so the UI's full chrome (toolbar, side panel, vault browser, chat) is
    available immediately — the user sees an empty graph + Add Repo prompt
    without losing access to the rest of the app.
    """
    import uvicorn

    _configure_logging(verbose)
    log = logging.getLogger("opentrace_agent.serve")

    from opentrace_agent.cli.serve import create_app
    from opentrace_agent.store import GraphStore

    # Bootstrap an empty DB when none is found, rather than refusing to
    # start or running in a half-broken vault-only mode. The UI relies on
    # graph routes (`/api/stats`, `/api/graph`, etc.) being mounted to
    # render its full chrome; an empty graph (``total_nodes=0``) lets it
    # render the inline empty-state overlay over the canvas while keeping
    # the toolbar, side panel, vault browser, and chat all reachable.
    try:
        resolved_db = _resolve_db(db_path, must_exist=True)
    except click.UsageError:
        resolved_db = _resolve_db(db_path, must_exist=False)
        db_parent = Path(resolved_db).parent
        db_parent.mkdir(parents=True, exist_ok=True)
        _ensure_gitignore(db_parent)
        # Opening GraphStore on a non-existent path creates the LadybugDB
        # file + initialises the schema. Close + reopen below so the
        # normal stats/echo path runs uniformly.
        with GraphStore(resolved_db) as _bootstrap:
            pass
        click.echo(f"Created empty graph DB at {resolved_db}")

    log.debug("Opening database: %s", resolved_db)
    # serve opens read-only so other readers (MCP, a second serve) can share
    # the DB file. Vault mutation routes escalate to a writable handle for
    # the duration of the write and drop back to read-only after. If a prior
    # writer was killed mid-write, self-heal the unreplayed journal instead of
    # refusing to start.
    store = _open_readonly_with_recovery(resolved_db)

    stats = store.get_stats()
    click.echo(f"Database: {resolved_db}")
    click.echo(f"  {stats['total_nodes']} nodes, {stats['total_edges']} edges")

    click.echo(f"Listening on http://{host}:{port}")

    app = create_app(store, db_path=resolved_db)

    try:
        uvicorn.run(app, host=host, port=port, log_level="debug" if verbose else "info")
    except KeyboardInterrupt:
        pass
    finally:
        if store is not None:
            store.close()


@app.command()
@click.argument("pattern")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="OpenTrace database path (auto-detected if omitted).",
)
@click.option("--json", "output_json", is_flag=True, help="Output structured JSON instead of text.")
def augment(pattern: str, db_path: str | None, output_json: bool) -> None:
    """Query the graph for context about a search pattern.

    Prints a short human-readable context block (< 50 lines) to stdout.
    With --json, emits structured JSON for machine consumption.
    Exits 0 with no output when the pattern matches nothing or no index is found.
    """
    from opentrace_agent.cli.augment import run_augment

    try:
        resolved = _resolve_db(db_path, must_exist=True)
    except click.UsageError:
        resolved = None
    run_augment(pattern, resolved, output_json=output_json)


@app.command("export")
@click.argument("output", default="opentrace.parquet.zip", type=click.Path())
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def export_cmd(output: str, db_path: str | None, verbose: bool) -> None:
    """Export the graph database as a .parquet.zip archive.

    The archive can be imported in the UI or via `opentraceai import`.
    """
    _configure_logging(verbose)

    from opentrace_agent.cli.export_import import export_database
    from opentrace_agent.store import GraphStore

    resolved_db = _resolve_db(db_path, must_exist=True)
    click.echo(f"Opening database at {resolved_db} ...")
    store = GraphStore(resolved_db, read_only=True)

    try:
        click.echo("Exporting ...")
        data = export_database(store)
    finally:
        store.close()

    out = Path(output)
    out.write_bytes(data)
    size_kb = len(data) / 1024
    click.echo(f"Wrote {out} ({size_kb:.1f} KB)")


@app.command("import")
@click.argument("archive", type=click.Path(exists=True, dir_okay=False, resolve_path=True))
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help=f"Database path (default: ./{OPENTRACE_DIR}/{DB_NAME}).",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def import_cmd(archive: str, db_path: str | None, verbose: bool) -> None:
    """Import a .parquet.zip archive into the graph database.

    Accepts archives exported from the UI or via `opentraceai export`.
    """
    _configure_logging(verbose)

    from opentrace_agent.cli.export_import import import_database
    from opentrace_agent.store import GraphStore

    resolved_db = _resolve_db(db_path)
    db_dir = Path(resolved_db).parent
    db_dir.mkdir(parents=True, exist_ok=True)
    _ensure_gitignore(db_dir)

    click.echo(f"Opening database at {resolved_db} ...")
    store = GraphStore(resolved_db)

    data = Path(archive).read_bytes()
    click.echo(f"Importing {archive} ({len(data) / 1024:.1f} KB) ...")

    def on_progress(msg: str) -> None:
        click.echo(f"  {msg}")

    try:
        result = import_database(store, data, on_progress=on_progress)
    finally:
        store.close()

    click.echo(
        f"Imported {result['nodes_created']} nodes, "
        f"{result['relationships_created']} relationships "
        f"({result['errors']} errors)"
    )


# ---------------------------------------------------------------------------
# config command group
# ---------------------------------------------------------------------------


def _resolve_config_path() -> Path:
    """Return the config file path, preferring an existing .opentrace/ dir."""
    from opentrace_agent.cli.config import CONFIG_NAME

    ot_dir = _find_opentrace_dir()
    if ot_dir is not None:
        return ot_dir / CONFIG_NAME
    return Path.cwd() / OPENTRACE_DIR / CONFIG_NAME


@app.group()
def config() -> None:
    """Read or write project configuration (.opentrace/config.yaml)."""


@config.command("set")
@click.argument("key", type=click.Choice(["org"]))
@click.argument("value")
def config_set(key: str, value: str) -> None:
    """Set a configuration value.

    \b
    Supported keys:
      org   Organisation ID (org_xxx) or slug (acme_corp)
    """
    from opentrace_agent.cli.config import load_config, save_config

    path = _resolve_config_path()
    data = load_config(path)
    data[key] = value
    save_config(path, data)
    _ensure_gitignore(path.parent)
    click.echo(f"{key}: {value}")


@config.command("get")
@click.argument("key", type=click.Choice(["org"]))
def config_get(key: str) -> None:
    """Get a configuration value."""
    from opentrace_agent.cli.config import load_config

    path = _resolve_config_path()
    data = load_config(path)
    val = data.get(key)
    if val is None:
        raise click.UsageError(f"'{key}' is not set. Run: opentraceai config set {key} <value>")
    click.echo(val)


@config.command("show")
def config_show() -> None:
    """Show all configuration values."""
    from opentrace_agent.cli.config import load_config

    path = _resolve_config_path()
    data = load_config(path)
    if not data:
        click.echo("No configuration set.")
        return
    for k, v in data.items():
        click.echo(f"{k}: {v}")


@config.command("path")
def config_path() -> None:
    """Print the config file path."""
    click.echo(_resolve_config_path())


@app.command()
@click.option("--resolve", is_flag=True, help="Also resolve an org-scoped token from project config.")
def login(resolve: bool) -> None:
    """Log in to api.opentrace.ai via your browser."""
    from opentrace_agent.cli.auth import load_tokens
    from opentrace_agent.cli.auth import login as do_login

    existing = load_tokens()
    if existing and existing.get("access_token"):
        if not click.confirm("Already logged in. Re-authenticate?", default=False):
            return

    click.echo("Opening browser to log in to OpenTrace ...")
    try:
        payload = do_login()
    except TimeoutError:
        raise click.ClickException("Login timed out — no response from browser within 5 minutes.")
    except Exception as exc:
        raise click.ClickException(f"Login failed: {exc}")

    scope = payload.get("scope", "")
    click.echo(f"Logged in to {payload.get('issuer', 'OpenTrace')} (scope: {scope}).")

    if resolve:
        from opentrace_agent.cli.auth import resolve_org_token
        from opentrace_agent.cli.config import find_config, load_config

        ot_dir = _find_opentrace_dir()
        config_path = find_config(ot_dir)
        if config_path is None:
            click.echo("No .opentrace/config.yaml found — skipping org token resolution.")
            return
        config = load_config(config_path)
        org = config.get("org")
        if not org:
            click.echo("No org set in config — skipping org token resolution.")
            return
        try:
            resolve_org_token(org)
            click.echo(f"Org token resolved for '{org}'.")
        except RuntimeError as exc:
            raise click.ClickException(f"Org token resolution failed: {exc}")


@app.command()
def logout() -> None:
    """Log out and remove saved credentials."""
    from opentrace_agent.cli.auth import clear_tokens
    from opentrace_agent.cli.credentials import clear_org_tokens

    cleared_user = clear_tokens()
    org_count = clear_org_tokens()
    if cleared_user or org_count:
        parts = []
        if cleared_user:
            parts.append("user credentials")
        if org_count:
            parts.append(f"{org_count} org token(s)")
        click.echo(f"Logged out. Removed {', '.join(parts)}.")
    else:
        click.echo("Not logged in.")


@app.command()
def whoami() -> None:
    """Show the current authentication status."""
    from opentrace_agent.cli.auth import load_tokens
    from opentrace_agent.cli.config import find_config, load_config
    from opentrace_agent.cli.credentials import load_org_token

    tokens = load_tokens()
    if not tokens:
        click.echo("Not logged in. Run 'opentraceai login' to authenticate.")
        return

    issuer = tokens.get("issuer", "unknown")
    scope = tokens.get("scope", "none")
    access_token = tokens.get("access_token", "")
    token_type = "user (otuat)" if access_token.startswith("otuat_") else "org-scoped (legacy)"
    created = tokens.get("created_at")

    click.echo(f"Issuer:  {issuer}")
    click.echo(f"Type:    {token_type}")
    click.echo(f"Scope:   {scope}")
    if isinstance(created, (int, float)):
        from datetime import datetime, timezone

        dt = datetime.fromtimestamp(created, tz=timezone.utc)
        click.echo(f"Issued:  {dt:%Y-%m-%d %H:%M:%S UTC}")

    # Show project org context
    ot_dir = _find_opentrace_dir()
    config_path = find_config(ot_dir)
    if config_path is not None:
        config = load_config(config_path)
        org = config.get("org")
        if org:
            org_token = load_org_token(org)
            if org_token:
                click.echo(f"Org:     {org} (token cached)")
            else:
                try:
                    from opentrace_agent.cli.auth import resolve_org_token

                    resolve_org_token(org)
                    click.echo(f"Org:     {org} (token resolved)")
                except RuntimeError as exc:
                    click.echo(f"Org:     {org} (exchange failed: {exc})")


@app.command()
def refresh() -> None:
    """Refresh the access token using the stored refresh token."""
    from opentrace_agent.cli.auth import refresh as do_refresh

    try:
        payload = do_refresh()
    except RuntimeError as exc:
        raise click.ClickException(str(exc))
    except Exception as exc:
        raise click.ClickException(f"Token refresh failed: {exc}")

    expires_in = payload.get("expires_in")
    if expires_in:
        click.echo(f"Token refreshed (expires in {expires_in}s).")
    else:
        click.echo("Token refreshed.")


# ---------------------------------------------------------------------------
# query command
# ---------------------------------------------------------------------------


@app.command()
@click.argument("query_string")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
@click.option(
    "-t",
    "--type",
    "query_type",
    type=click.Choice(["cypher", "fts"]),
    default="cypher",
    show_default=True,
    help="Query language: cypher (default) or fts (full-text search).",
)
@click.option(
    "--limit",
    default=100,
    show_default=True,
    help="Maximum rows to return (FTS only).",
)
@click.option(
    "--output",
    "output_format",
    type=click.Choice(["table", "json", "jsonl"]),
    default="table",
    show_default=True,
    help="Output format.",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def query(
    query_string: str,
    db_path: str | None,
    query_type: str,
    limit: int,
    output_format: str,
    verbose: bool,
) -> None:
    """Run a Cypher or full-text search query against the graph database.

    \b
    Examples:
      opentraceai query "MATCH (n:Node) RETURN n.type, count(n)"
      opentraceai query "MATCH (n:Node {type: 'Function'}) RETURN n.name LIMIT 10"
      opentraceai query "parse" --type fts
      opentraceai query "MATCH (a)-[r:RELATES]->(b) RETURN a.name, r.type, b.name LIMIT 5"
      opentraceai query "GraphStore" --type fts --output json
    """
    import json as json_mod
    import time

    _configure_logging(verbose)

    from opentrace_agent.store import GraphStore

    resolved_db = _resolve_db(db_path, must_exist=True)
    store = GraphStore(resolved_db, read_only=True)

    try:
        t0 = time.monotonic()

        if query_type == "fts":
            rows, columns = _run_fts_query(store, query_string, limit)
        else:
            rows, columns = _run_cypher_query(store, query_string)

        elapsed = time.monotonic() - t0

        if output_format == "json":
            data = [dict(zip(columns, row)) for row in rows]
            click.echo(json_mod.dumps(data, indent=2, default=str))
        elif output_format == "jsonl":
            for row in rows:
                click.echo(json_mod.dumps(dict(zip(columns, row)), default=str))
        else:
            _print_table(columns, rows)

        click.echo(f"\n{len(rows)} row(s) in {elapsed:.3f}s", err=True)
    finally:
        store.close()


def _run_cypher_query(
    store: "GraphStore",  # noqa: F821
    query_string: str,
) -> tuple[list[list], list[str]]:
    """Execute a Cypher query and return (rows, column_names)."""
    result = store._conn.execute(query_string)
    columns = result.get_column_names()
    rows: list[list] = []
    while result.has_next():
        rows.append(result.get_next())
    return rows, columns


def _run_fts_query(
    store: "GraphStore",  # noqa: F821
    query_string: str,
    limit: int,
) -> tuple[list[list], list[str]]:
    """Run an FTS query and return matching nodes with scores."""
    result = store._conn.execute(
        "CALL QUERY_FTS_INDEX('Node', 'node_fts', $query, top := $limit) RETURN node.id, node.name, node.type, score",
        parameters={"query": query_string, "limit": limit},
    )
    columns = ["id", "name", "type", "score"]
    rows: list[list] = []
    while result.has_next():
        rows.append(result.get_next())
    return rows, columns


def _print_table(columns: list[str], rows: list[list]) -> None:
    """Print rows as an aligned text table."""
    if not rows:
        click.echo("(no results)")
        return

    # Stringify all values
    str_rows = [[str(v) for v in row] for row in rows]
    widths = [len(c) for c in columns]
    for row in str_rows:
        for i, val in enumerate(row):
            if i < len(widths):
                widths[i] = max(widths[i], len(val))

    # Header
    header = "  ".join(c.ljust(widths[i]) for i, c in enumerate(columns))
    click.echo(header)
    click.echo("  ".join("─" * w for w in widths))

    # Rows
    for row in str_rows:
        line = "  ".join((row[i] if i < len(row) else "").ljust(widths[i]) for i in range(len(columns)))
        click.echo(line)


@app.command()
@click.argument("file_path")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="OpenTrace database path (auto-detected if omitted).",
)
@click.option(
    "--lines",
    "line_spec",
    default=None,
    help="Comma-separated line ranges, e.g. '10-25,40-60'.",
)
@click.option("--json", "output_json", is_flag=True, help="Output structured JSON instead of text.")
def impact(file_path: str, db_path: str | None, line_spec: str | None, output_json: bool) -> None:
    """Analyze the blast radius of changes to a file.

    Finds functions/classes defined in FILE_PATH, then walks incoming
    relationships (CALLS, IMPORTS, DEPENDS_ON) to show what depends on them.
    With --json, emits structured JSON for machine consumption.
    Exits 0 with no output when the file is not indexed or no index is found.
    """
    from opentrace_agent.cli.impact import run_impact

    try:
        resolved = _resolve_db(db_path, must_exist=True)
    except click.UsageError:
        resolved = None

    line_ranges: list[tuple[int, int]] | None = None
    if line_spec:
        line_ranges = []
        for part in line_spec.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                if "-" in part:
                    lo, hi = part.split("-", 1)
                    line_ranges.append((int(lo), int(hi)))
                else:
                    n = int(part)
                    line_ranges.append((n, n))
            except ValueError:
                continue

    run_impact(file_path, resolved, line_ranges, output_json=output_json)


_REPOS_METADATA_FIELDS: tuple[str, ...] = (
    "sourceUri",
    "branch",
    "commitSha",
    "commitMessage",
    "repoPath",
    "indexedAt",
    "durationSeconds",
    "nodesCreated",
    "relationshipsCreated",
    "filesProcessed",
    "classesExtracted",
    "functionsExtracted",
    "opentraceaiVersion",
)


@app.command()
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
def repos(db_path: str | None) -> None:
    """List all indexed repositories in the graph database.

    Emits a JSON array, one entry per ``Repository`` node, with the
    full set of per-repo metadata. Every entry carries the same keys
    (all nullable except ``id`` and ``name``) so that consumers can
    rely on a stable shape. The fields are sourced from
    ``store.get_metadata()`` — the same place ``stats --output json``
    already surfaces them — with graph-node ``properties`` used as a
    fallback for the three fields an indexer could plausibly write
    there (``sourceUri``/``branch``/``commitSha``/``repoPath``).

    Metadata entries whose ``repoId`` doesn't match any graph node
    are excluded: this command reports what's in the graph, not what
    has ever been indexed.
    """
    import json

    from opentrace_agent.store import GraphStore

    resolved_db = _resolve_db(db_path, must_exist=True)
    store = GraphStore(resolved_db, read_only=True)

    try:
        # Index the metadata up-front so the per-node merge is O(1).
        metadata_by_id: dict[str, dict[str, object]] = {}
        for entry in store.get_metadata():
            repo_id = entry.get("repoId")
            if isinstance(repo_id, str) and repo_id:
                metadata_by_id[repo_id] = entry

        repos_list: list[dict[str, object]] = []
        for repo in store.list_repositories():
            node_id = repo["id"]
            graph_props = repo["properties"]

            # Match by node id, not by name — they can diverge.
            md = metadata_by_id.get(node_id, {})

            record: dict[str, object] = {"id": node_id, "name": repo["name"]}
            for field in _REPOS_METADATA_FIELDS:
                # Metadata is authoritative when present. Graph-node
                # properties cover the same three pre-existing keys as
                # a fallback for indexers that populate them there.
                record[field] = md.get(field) if md.get(field) is not None else graph_props.get(field)
            repos_list.append(record)

        click.echo(json.dumps(repos_list, indent=2, default=str))
    finally:
        store.close()


def _parse_source_read_line_spec(spec: str) -> tuple[int | None, int | None]:
    """Parse a ``--lines`` value for ``source-read``.

    Accepts three forms:

    - ``"10-25"`` → ``(10, 25)`` — closed range
    - ``"10-"``   → ``(10, None)`` — open-ended, from 10 to end of file
    - ``"10"``    → ``(10, 10)`` — single line

    Returns ``(None, None)`` for an empty spec. Raises ``click.BadParameter``
    on unparseable input, negative or zero line numbers, or reversed
    ranges (``end < start``): source files are 1-indexed and ranges are
    non-decreasing, so any other input is almost certainly a mistake the
    caller wants reported, not silently coerced into an empty slice.
    """
    if not spec:
        return None, None

    def _bad(detail: str) -> click.BadParameter:
        return click.BadParameter(
            f"invalid --lines value: {spec!r} ({detail}; expected 'N', 'N-M', or 'N-' with N >= 1 and M >= N)"
        )

    parts = spec.split("-", 1)
    try:
        start = int(parts[0])
    except ValueError as e:
        raise _bad("start is not an integer") from e
    if start < 1:
        raise _bad("start must be >= 1")

    if len(parts) == 1:
        return start, start

    tail = parts[1]
    if not tail:
        # "10-" → open-ended; caller lets _print_file_slice default to EOF.
        return start, None
    try:
        end = int(tail)
    except ValueError as e:
        raise _bad("end is not an integer") from e
    if end < 1:
        raise _bad("end must be >= 1")
    if end < start:
        raise _bad(f"end ({end}) must be >= start ({start})")
    return start, end


@app.command("get-node")
@click.argument("node_id")
@click.option("--json", "output_json", is_flag=True, help="Emit structured JSON instead of text.")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
def get_node_cmd(node_id: str, output_json: bool, db_path: str | None) -> None:
    """Fetch a single node and its 1-hop neighbors.

    Returns the node's full details plus every immediate neighbor (in
    either direction) along with the connecting relationship. Same
    envelope the MCP server's ``get_node`` tool returns; this is the
    one-shot CLI surface for plugins that don't embed an MCP client.

    Each neighbor's relationship carries a derived ``direction`` field
    (``"outgoing"`` when the requested node is the source, ``"incoming"``
    when it is the target) so callers don't reinvent the comparison.

    Exits 1 if the node id is not in the graph.
    """
    from opentrace_agent.cli.get_node import run_get_node

    resolved_db = _resolve_db(db_path, must_exist=True)
    run_get_node(node_id, resolved_db, output_json=output_json)


@app.command("traverse")
@click.argument("node_id")
@click.option(
    "--direction",
    type=click.Choice(["outgoing", "incoming", "both"]),
    default="outgoing",
    show_default=True,
    help="Direction to walk relative to the start node.",
)
@click.option(
    "--depth",
    default=2,
    type=int,
    show_default=True,
    help="Maximum BFS depth (clamped to 10 to match the MCP traverse_graph cap).",
)
@click.option(
    "--rel-type",
    "rel_type",
    default=None,
    help="Restrict to one relationship type (e.g. CALLS, IMPORTS, DEFINES).",
)
@click.option("--json", "output_json", is_flag=True, help="Emit structured JSON instead of text.")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
def traverse_cmd(
    node_id: str,
    direction: str,
    depth: int,
    rel_type: str | None,
    output_json: bool,
    db_path: str | None,
) -> None:
    """BFS walk relationships from a starting node.

    Walks up to ``--depth`` hops in the chosen direction, optionally
    restricted to one relationship type. Each result preserves its
    real per-hop depth so callers can distinguish a direct neighbor
    from a transitive one.

    For "node + immediate neighbors both directions", prefer
    ``opentrace get-node`` — it adds direction classification and a
    cleaner envelope for that specific shape.

    Exits 1 if the start node id is not in the graph.
    """
    from opentrace_agent.cli.traverse import run_traverse

    resolved_db = _resolve_db(db_path, must_exist=True)
    run_traverse(
        node_id,
        resolved_db,
        direction=direction,
        depth=depth,
        rel_type=rel_type,
        output_json=output_json,
    )


@app.command("source-grep")
@click.argument("pattern")
@click.option(
    "--repo",
    default=None,
    help="Filter to a specific repo by id (use the 'id' field from `opentrace repos`).",
)
@click.option(
    "--include",
    default=None,
    help="File glob filter passed to ripgrep (e.g. '*.py', '*.{ts,tsx}').",
)
@click.option("--limit", default=50, type=int, show_default=True, help="Max matches per repo.")
@click.option("--json", "output_json", is_flag=True, help="Emit structured JSON instead of text.")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
def source_grep_cmd(
    pattern: str,
    repo: str | None,
    include: str | None,
    limit: int,
    output_json: bool,
    db_path: str | None,
) -> None:
    """Regex search across the file contents of indexed repositories.

    Where ``source-search`` queries the knowledge graph, this walks the
    actual files on disk with ripgrep. Useful for matches inside
    function bodies, hits in non-code files (READMEs, configs), or any
    pattern the indexer didn't model. Results are prefixed with the
    repo id and use repo-relative paths — the indexing host's absolute
    paths are never echoed to the caller.

    For repos cloned via ``fetch-and-index``, the clone is looked up
    under the current ``$HOME/.opentrace/repos/<org>/<name>/``; if the
    DB was indexed on a different machine, this re-homing handles the
    portable case automatically. Repos indexed in place via
    ``opentrace index <path>`` are looked up at their stored absolute
    path. Repos whose clone is missing locally surface a per-repo
    error rather than silently returning no matches.
    """
    from opentrace_agent.cli.source_grep import run_source_grep

    resolved_db = _resolve_db(db_path, must_exist=True)
    run_source_grep(
        pattern,
        resolved_db,
        repo=repo,
        include=include,
        limit=limit,
        output_json=output_json,
    )


@app.command("source-search")
@click.argument("query")
@click.option(
    "--repo",
    default=None,
    help="Filter to a specific repo by id (use the 'id' field from `opentrace repos`).",
)
@click.option(
    "--types",
    "node_types",
    default=None,
    help="Comma-separated node types to filter by (e.g. 'Function,Class').",
)
@click.option("--limit", default=20, type=int, show_default=True, help="Max results to return.")
@click.option("--json", "output_json", is_flag=True, help="Emit structured JSON instead of text.")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
def source_search_cmd(
    query: str,
    repo: str | None,
    node_types: str | None,
    limit: int,
    output_json: bool,
    db_path: str | None,
) -> None:
    """Full-text search across the indexed graph.

    Searches each node's name, type, summary, and path via Kuzu's BM25
    FTS index. Because ``type`` is part of the indexed text, a query
    like ``Function`` matches every Function node — use ``--types`` for
    node-kind filtering rather than putting the type in the query.
    Optionally restricts to a single repository (``--repo <id>``).
    Pass ``--json`` for a structured response with ``totalResults`` /
    ``truncated`` flags.
    """
    from opentrace_agent.cli.source_search import run_source_search

    types_list: list[str] | None = None
    if node_types:
        types_list = [t.strip() for t in node_types.split(",") if t.strip()]
        if not types_list:
            types_list = None

    resolved_db = _resolve_db(db_path, must_exist=True)
    run_source_search(
        query,
        resolved_db,
        repo=repo,
        node_types=types_list,
        limit=limit,
        output_json=output_json,
    )


@app.command("source-read")
@click.option("--node-id", default=None, help="Graph node ID to read source for.")
@click.option("--path", "file_path", default=None, help="File path relative to repo root.")
@click.option(
    "--lines",
    "line_spec",
    default=None,
    help="Line range: '10-25' for a closed range, '10-' for line 10 to end of file, or '10' for a single line.",
)
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted).",
)
def source_read(node_id: str | None, file_path: str | None, line_spec: str | None, db_path: str | None) -> None:
    """Read source code for a graph node or file path.

    Given a node ID, resolves the file path and line range from the graph,
    then reads the source from the local filesystem. Given a file path,
    searches for the file in known repo paths.
    """
    from opentrace_agent.store import GraphStore

    if not node_id and not file_path:
        raise click.UsageError("Provide --node-id or --path.")

    resolved_db = _resolve_db(db_path, must_exist=True)
    store = GraphStore(resolved_db, read_only=True)

    try:
        if node_id:
            _read_source_by_node(store, node_id)
        elif file_path:
            start_line, end_line = _parse_source_read_line_spec(line_spec or "")
            _read_source_by_path(store, file_path, start_line, end_line)
    finally:
        store.close()


def _read_source_by_node(store: "GraphStore", node_id: str) -> None:  # noqa: F821
    """Read source code for a specific graph node."""
    node = store.get_node(node_id)
    if not node:
        raise click.ClickException(f"Node {node_id} not found.")

    props = node.get("properties") or {}
    if isinstance(props, str):
        try:
            props = __import__("json").loads(props)
        except Exception:
            props = {}

    file_path = props.get("path")
    start_line = props.get("start_line") or props.get("startLine")
    end_line = props.get("end_line") or props.get("endLine")

    # If node has no direct path, try to find it via DEFINES relationship
    # (Function/Class nodes are DEFINED_IN a File node which has the path)
    if not file_path:
        try:
            neighbors = store._get_neighbors(node_id, "outgoing")
            for nb_node, nb_rel in neighbors:
                if nb_node["type"] == "File":
                    nb_props = nb_node.get("properties") or {}
                    if isinstance(nb_props, str):
                        nb_props = __import__("json").loads(nb_props)
                    file_path = nb_props.get("path")
                    if file_path:
                        break
        except Exception:
            pass

    if not file_path:
        # Last resort: extract from the node ID (format: repo/path/to/file.py::SymbolName).
        # Repo ids may contain "/" (e.g. "owner/repo"), so the prefix is
        # matched against the indexed repo ids longest-first rather than
        # by splitting on the first "/".
        if "::" in node_id:
            from opentrace_agent.cli.source_search import strip_repo_prefix

            candidate = node_id.split("::", 1)[0]
            repo_ids = sorted(store.list_repository_ids(), key=len, reverse=True)
            stripped = strip_repo_prefix(candidate, repo_ids)
            if stripped:
                file_path = stripped

    if not file_path:
        raise click.ClickException(f"Node {node_id} has no file path.")

    _read_source_by_path(store, file_path, start_line, end_line)


def _read_source_by_path(
    store: "GraphStore",  # noqa: F821
    file_path: str,
    start_line: int | None = None,
    end_line: int | None = None,
) -> None:
    """Read source code from a file, searching repo paths."""
    from pathlib import Path as P

    # Try absolute path first
    if P(file_path).is_absolute() and P(file_path).exists():
        _print_file_slice(file_path, start_line, end_line)
        return

    # Search repo paths from metadata
    metadata = store.get_metadata()
    for entry in metadata:
        repo_path = entry.get("repoPath")
        if repo_path:
            candidate = P(repo_path) / file_path
            if candidate.exists():
                _print_file_slice(str(candidate), start_line, end_line)
                return

    # Try CWD as fallback
    cwd_candidate = P.cwd() / file_path
    if cwd_candidate.exists():
        _print_file_slice(str(cwd_candidate), start_line, end_line)
        return

    raise click.ClickException(f"Source file not found: {file_path}")


def _print_file_slice(
    abs_path: str,
    start_line: int | None = None,
    end_line: int | None = None,
) -> None:
    """Print a file or a slice of it, streaming line-by-line.

    Reads only as much of the file as the requested slice needs: a
    closed range stops at ``end_line``; an open-ended range reads to
    EOF but only buffers the selected region. This avoids
    materializing a multi-MB source file in memory just to print
    twenty lines from the middle of it.

    Iterating the file in text mode handles the trailing-newline case
    naturally — Python yields exactly one element per real line, so an
    open-ended range against a file ending in ``\\n`` produces no
    phantom trailing blank line.
    """
    from pathlib import Path as P

    path = P(abs_path)

    if start_line is None:
        # Whole-file dump: stream in 64KiB chunks rather than reading
        # the file into a single string. Trailing ``click.echo()``
        # preserves the prior behaviour of always emitting a final
        # newline regardless of whether the file ends in one.
        with path.open() as f:
            for chunk in iter(lambda: f.read(65536), ""):
                click.echo(chunk, nl=False)
        click.echo()
        return

    start_idx = max(1, start_line)
    end_idx = end_line  # None == open-ended, read to EOF

    selected: list[str] = []
    total_lines = 0
    with path.open() as f:
        for lineno, raw in enumerate(f, start=1):
            total_lines = lineno
            if lineno < start_idx:
                continue
            if end_idx is not None and lineno > end_idx:
                break
            selected.append(raw.rstrip("\n"))

    # Closed ranges echo the requested end (preserves prior behaviour
    # even when the request runs past EOF); open-ended ranges report
    # the real last line we read so the header doesn't lie.
    resolved_end = end_idx if end_idx is not None else total_lines
    click.echo(f"// {abs_path}:{start_line}-{resolved_end}")
    for i, line in enumerate(selected):
        click.echo(f"{start_idx + i}\t{line}")


def _do_clone(repo_url: str, clone_dir: Path, ref: str | None, token: str | None) -> Path:
    """Clone a repo into *clone_dir*, returning the local path."""
    from opentrace_agent.sources.code.git_cloner import GitCloner

    click.echo(f"Cloning {repo_url} ...")
    cloner = GitCloner()
    kwargs: dict[str, object] = {"dest": clone_dir}
    if ref:
        kwargs["ref"] = ref
    if token:
        kwargs["token"] = token
    try:
        return cloner.clone(repo_url, **kwargs)
    except Exception as e:
        raise click.ClickException(f"Clone failed: {e}")


# Matches the userinfo segment of a URL (``scheme://user:pass@host``).
# We scrub this before echoing any git output because the persisted
# origin URL — written by GitCloner._inject_token during the initial
# clone — contains an oauth2:<token>@ prefix that git happily echoes
# back in error messages on a failed fetch.
_URL_USERINFO_RE = re.compile(r"://[^@/\s]+@")


def _scrub_token(message: str) -> str:
    """Redact userinfo (``user:password@``) from any URLs in *message*.

    Defensive: even if no token is in play right now, an older clone in
    ``~/.opentrace/repos`` may still carry one in its origin URL, and
    we don't want to assume what the caller's token looked like.
    """
    return _URL_USERINFO_RE.sub("://[REDACTED]@", message)


def _update_existing_clone(clone_dir: Path, ref: str | None) -> None:
    """Best-effort fast-forward of an already-cloned repo.

    Auth is reused from the persisted origin URL (the initial clone
    embeds the token there if one was supplied). We never re-inject
    the token here, so it can't appear in our process args; the only
    leak vector is git echoing its origin URL on error, which we scrub
    before logging.

    Honors *ref* by fetching the named ref and forcing the local branch
    to its FETCH_HEAD. This makes the re-fetch path match the
    fresh-clone path: ``--ref main`` ends up on ``main`` whether or not
    the directory already existed.

    On failure we warn (with the scrubbed message) and return; the
    caller proceeds with whatever's currently checked out, which may
    be stale. Never raises.
    """
    # Refuse refs that look like flags. Git ref names can't legitimately
    # start with '-' (git check-ref-format rejects them), and passing
    # one as a positional to `git fetch ... <ref>` or `git checkout -B
    # <ref> ...` would let it be reinterpreted as an option.
    if ref and ref.startswith("-"):
        click.echo(
            f"Warning: refusing ref {ref!r} (starts with '-'); continuing with current checkout, which may be stale.",
            err=True,
        )
        return

    from opentrace_agent.sources.code.git_cloner import _clean_env

    def _run(args: list[str]) -> tuple[int, str]:
        try:
            proc = subprocess.run(
                ["git", "-C", str(clone_dir), *args],
                capture_output=True,
                text=True,
                timeout=60,
                env=_clean_env(),
            )
        except subprocess.TimeoutExpired:
            return 124, "git command timed out after 60s"
        except Exception as e:
            return 1, _scrub_token(str(e))
        msg = (proc.stderr or proc.stdout or "").strip()
        return proc.returncode, _scrub_token(msg)

    if ref:
        rc, msg = _run(["fetch", "--depth=1", "origin", ref])
        if rc != 0:
            click.echo(
                f"Warning: 'git fetch origin {ref}' failed (continuing with current "
                f"checkout, which may be stale): {msg}",
                err=True,
            )
            return
        rc, msg = _run(["checkout", "-B", ref, "FETCH_HEAD"])
        if rc != 0:
            click.echo(
                f"Warning: 'git checkout {ref}' failed (continuing with current checkout, which may be stale): {msg}",
                err=True,
            )
        return

    rc, msg = _run(["pull", "--ff-only"])
    if rc != 0:
        click.echo(
            f"Warning: 'git pull --ff-only' failed (continuing with current checkout, which may be stale): {msg}",
            err=True,
        )


@app.command("fetch-and-index")
@click.argument("repo_url")
@click.option("--repo-id", default=None, help="Custom repository ID (defaults to repo name).")
@click.option(
    "--token",
    default=None,
    envvar=("OPENTRACE_GIT_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN"),
    help=(
        "Personal access token (PAT) for private repos. Falls back to "
        "OPENTRACE_GIT_TOKEN, GITHUB_TOKEN, or GITLAB_TOKEN env vars (in that order)."
    ),
)
@click.option("--ref", default=None, help="Branch or tag to clone (defaults to repo default branch).")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help=f"Database path (default: ./{OPENTRACE_DIR}/{DB_NAME}).",
)
@click.option("--batch-size", default=200, show_default=True, help="Items per batch.")
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def fetch_and_index(
    repo_url: str,
    repo_id: str | None,
    token: str | None,
    ref: str | None,
    db_path: str | None,
    batch_size: int,
    verbose: bool,
) -> None:
    """Clone a remote git repository and index it into the graph.

    Performs a shallow clone of REPO_URL into ~/.opentrace/repos/, then
    runs the full indexing pipeline on the cloned repository. The clone
    is kept permanently so source-read can access the files later.

    For private repos, pass --token with a GitHub/GitLab personal access
    token (PAT), or set OPENTRACE_GIT_TOKEN, GITHUB_TOKEN, or GITLAB_TOKEN
    (resolved in that order by Click via the --token envvar binding).
    """
    _configure_logging(verbose)

    # Determine repo name from URL
    url_parts = repo_url.rstrip("/").split("/")
    inferred_name = url_parts[-1].removesuffix(".git") if url_parts else "repo"
    effective_repo_id = repo_id or inferred_name

    # Infer org/repo from URL for directory structure
    org = url_parts[-2] if len(url_parts) >= 2 else "unknown"

    # Clone into a persistent directory under ~/.opentrace/repos/
    repos_dir = Path.home() / ".opentrace" / "repos" / org
    repos_dir.mkdir(parents=True, exist_ok=True)
    clone_dir = repos_dir / inferred_name

    if clone_dir.exists() and (clone_dir / ".git").exists():
        click.echo(f"Repository already cloned at {clone_dir}, updating...")
        _update_existing_clone(clone_dir, ref)
        local_path = clone_dir
    elif clone_dir.exists():
        # Directory exists but no .git — remove and re-clone
        import shutil

        shutil.rmtree(clone_dir)
        clone_dir.mkdir(parents=True, exist_ok=True)
        local_path = _do_clone(repo_url, clone_dir, ref, token)
    else:
        clone_dir.mkdir(parents=True, exist_ok=True)
        local_path = _do_clone(repo_url, clone_dir, ref, token)

    click.echo(f"Cloned to {local_path}")

    resolved_db = _resolve_db(db_path)
    elapsed = _run_indexing_pipeline(
        source_path=local_path,
        repo_id=effective_repo_id,
        db_path=resolved_db,
        batch_size=batch_size,
        verbose=verbose,
        # `_collect_metadata` reads sourceUri from the local clone's
        # `git remote origin` URL, which would echo back our token-
        # bearing URL. Override with the user-supplied repo_url so the
        # persisted sourceUri is the clean form.
        extra_metadata={"sourceUri": repo_url},
    )

    click.echo(f"Done in {elapsed:.1f}s. Repository '{effective_repo_id}' is now indexed.")


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(levelname)s %(name)s: %(message)s",
    )


# Knowledge-graph features (cluster, analyze, export-graph, watch, hook,
# ingest, llm-extraction-eval) are registered as first-class top-level
# commands below — no separate `graph` subgroup.


@app.command()
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="OpenTrace database path (auto-detected if omitted).",
)
@click.option("--json", "output_json", is_flag=True, help="Output structured JSON.")
def cluster(db_path: str | None, output_json: bool) -> None:
    """Run community detection over the stored graph.

    Reads non-internal nodes + edges, runs Leiden (falls back to Louvain),
    re-splits oversized or low-cohesion communities, and writes ``Community``
    nodes + ``MEMBER_OF_COMMUNITY`` edges. Idempotent — re-running clears
    prior Community state before writing.
    """
    from opentrace_agent.cli.cluster_cmd import run_cluster_cli

    resolved = _resolve_db(db_path, must_exist=True)
    run_cluster_cli(resolved, output_json=output_json)


@app.command()
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="OpenTrace database path (auto-detected if omitted).",
)
@click.option("--gods", "god_limit", default=10, show_default=True, help="Top-N god nodes to surface.")
@click.option(
    "--bridges",
    "bridge_limit",
    default=10,
    show_default=True,
    help="Top-N cross-community bridges to surface.",
)
@click.option("--json", "output_json", is_flag=True, help="Output structured JSON.")
def analyze(db_path: str | None, god_limit: int, bridge_limit: int, output_json: bool) -> None:
    """Surface god nodes, cross-community bridges, and suggested questions.

    Run ``opentraceai cluster`` first — bridges depend on community
    membership. Without communities, only god nodes are reported.
    """
    from opentrace_agent.cli.analyze_cmd import run_analyze_cli

    resolved = _resolve_db(db_path, must_exist=True)
    run_analyze_cli(
        resolved,
        god_limit=god_limit,
        bridge_limit=bridge_limit,
        output_json=output_json,
    )


from opentrace_agent.cli.export_graph import export_graph_app as _export_graph_app  # noqa: E402

app.add_command(_export_graph_app)

# `hook` and `watch` were removed 2026-08-05. Both were scaffolding for
# incremental indexing, which never landed: `hook install` wrote a git
# post-commit hook invoking `opentraceai index --incremental` — a flag that has
# never existed — and `watch`'s rebuild callback was an explicit no-op shim.
# A hook that silently does nothing after every commit is worse than no hook:
# it reports success while the graph goes stale. Re-add them with the
# incremental pipeline they presuppose, not before.


@app.command()
@click.argument("source_id")
@click.argument("target_id")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="OpenTrace database path (auto-detected if omitted).",
)
@click.option("--max-hops", default=6, show_default=True, help="Maximum path length.")
@click.option("--json", "output_json", is_flag=True, help="Output structured JSON.")
def path(
    source_id: str,
    target_id: str,
    db_path: str | None,
    max_hops: int,
    output_json: bool,
) -> None:
    """Find a shortest path between two graph nodes by ID.

    Returns the sequence of node IDs from SOURCE_ID to TARGET_ID via the
    retrieval-layer BFS (no networkx dependency). When no route exists
    within MAX_HOPS, prints a friendly message and exits cleanly.
    """
    import json as _json

    from opentrace_agent.retrieval import find_path as _find_path
    from opentrace_agent.store import GraphStore

    resolved = _resolve_db(db_path, must_exist=True)
    with GraphStore(resolved) as store:
        result = _find_path(store, source_id, target_id, max_hops=max_hops)

    path_steps = result.get("path") or []
    if not path_steps:
        err = result.get("error")
        if err:
            reason, friendly = "node not found", "Node not found."
        elif result.get("length") is None:
            reason, friendly = "no path", "No path between those nodes."
        else:
            reason, friendly = (
                "exceeds max_hops",
                f"A path exists but is longer than {max_hops} hops — raise --max-hops to see it.",
            )
        if output_json:
            click.echo(_json.dumps({"path": [], "reason": reason}))
        else:
            click.echo(friendly)
        return

    ids = [step["node"]["id"] for step in path_steps]
    if output_json:
        click.echo(_json.dumps({"path": ids, "hops": len(ids) - 1}))
    else:
        click.echo(" → ".join(ids))


# Note: the standalone ``opentraceai ingest`` command was removed in the
# ingestion-unification work. Single-file/URL ingestion goes through
# ``opentraceai index --wiki <path>``, which routes the source through the
# unified wiki doc pass (one LLM call → the doc's one-line summary).
