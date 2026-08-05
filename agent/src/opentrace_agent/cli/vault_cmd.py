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

"""``opentraceai vault`` — vault management commands.

Vaults are knowledge collections compiled from doc files via
``opentraceai index --wiki``. Each vault has a scope:

* **local** (default) — lives at ``<project>/.opentrace/vaults/<name>/``.
  Visible only to graphs in the same project.
* **global** — lives at ``~/.opentrace/vaults/<name>/`` (or
  ``$OT_VAULT_ROOT``). Can be attached to any graph on the machine.

The disk vault is canonical; each graph holds a derived mirror written
when the vault is compiled or attached. ``vault list`` flags graphs whose
mirror has drifted behind the disk vault's ``last_compiled_at``.
"""

from __future__ import annotations

import os
from pathlib import Path

import click

from opentrace_agent.wiki.paths import (
    InvalidVaultName,
    Scope,
    list_vaults_with_scope,
    move_vault_dir,
    resolve_vault_scope,
)


@click.group()
def vault() -> None:
    """Vault management — ingest, attach, detach, list, show, promote, demote."""


# ---------------------------------------------------------------------------
# Shared helpers (also imported by cli/main.py for index --wiki)
# ---------------------------------------------------------------------------


def _autodetect_provider() -> str:
    """Pick a provider from env when --provider was omitted.

    Priority: ANTHROPIC_API_KEY → GEMINI/GOOGLE_API_KEY → OPENAI_API_KEY.
    Hard-fail with the shared backend message when no key is set; no
    silent fallback that would error later at the API boundary.

    Specialty backends (kimi, local/ollama) require an explicit
    ``--provider`` because their env signal is different.
    """
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return "gemini"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"

    from opentrace_agent.sources.markdown.clients import (
        actionable_no_backend_message,
    )

    raise click.ClickException(actionable_no_backend_message())


def _open_graph_store(db: str | None):
    """Open a GraphStore for vault operations, or return None.

    Resolves *db* explicitly when given, otherwise walks up via ``find_db``
    looking for ``.opentrace/index.db``. Translates LadybugDB lock errors
    into actionable ``ClickException`` messages.
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
        if "Could not set lock on file" not in str(e):
            raise
        raise click.ClickException(
            f"graph DB at {path} is held by another process — typically a "
            "running `opentraceai serve` backing the UI. Stop that server "
            "and retry, or use the UI to manage vaults."
        ) from e


def _resolve_vault(
    name: str,
    *,
    scope_hint: Scope | None,
    project_root: Path | None,
) -> tuple[Scope, Path]:
    """Find a vault by name. Raises a friendly ClickException if not found."""
    found = resolve_vault_scope(name, project_root=project_root, prefer=scope_hint)
    if found is not None:
        return found
    visible = list_vaults_with_scope(project_root=project_root)
    if visible:
        available = "\n".join(f"  {scope:<7} {n}" for scope, n in visible)
        msg = f"vault {name!r} not found. Visible vaults:\n{available}"
    else:
        msg = f"vault {name!r} not found. No vaults exist yet — compile one with `opentraceai index --wiki`."
    raise click.ClickException(msg)


# ---------------------------------------------------------------------------
# `vault list`
# ---------------------------------------------------------------------------


@vault.command("list")
@click.option(
    "--global-only",
    is_flag=True,
    help=(
        "Show every global vault on the machine (regardless of whether "
        "the current graph has it attached). Without this flag, ``vault list`` "
        "shows local + global vaults visible from this project, with "
        "attachment status against the current graph."
    ),
)
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Graph DB. Auto-discovered if omitted.",
)
def vault_list(global_only: bool, db_path: str | None) -> None:
    """List vaults, with scope + attachment status against the current graph."""
    project_root = Path.cwd()

    if global_only:
        from opentrace_agent.wiki.paths import list_vaults

        names = list_vaults(scope="global", project_root=project_root)
        if not names:
            click.echo("No global vaults on this machine.")
            return
        click.echo(f"Global vaults ({len(names)}):")
        for n in names:
            click.echo(f"  {n}")
        return

    pairs = list_vaults_with_scope(project_root=project_root)
    if not pairs:
        click.echo("No vaults visible from this project.")
        return

    store = _open_graph_store(db_path)
    attached_by_name = {}
    if store is not None:
        try:
            for v in store.list_nodes("KnowledgeVault", limit=10_000):
                props = v.get("properties") or {}
                attached_by_name[props.get("vault") or v.get("name")] = props
        finally:
            store.close()

    click.echo(f"Vaults ({len(pairs)}):")
    for scope, name in pairs:
        mirror_status = ""
        if name in attached_by_name:
            props = attached_by_name[name]
            mirror_at = props.get("mirror_compiled_at") or ""
            # Read disk timestamp.
            try:
                from opentrace_agent.wiki.paths import metadata_path
                from opentrace_agent.wiki.vault import load_metadata

                meta = load_metadata(
                    metadata_path(name, scope=scope, project_root=project_root),
                    name=name,
                )
                disk_at = meta.last_compiled_at or ""
            except Exception:  # noqa: BLE001
                disk_at = ""

            if mirror_at and disk_at and mirror_at < disk_at:
                mirror_status = "  STALE (disk newer than graph mirror)"
            else:
                mirror_status = "  attached"
        else:
            mirror_status = "  (not attached to current graph)"
        click.echo(f"  {scope:<7} {name}{mirror_status}")


# ---------------------------------------------------------------------------
# `vault show`
# ---------------------------------------------------------------------------


@vault.command("show")
@click.argument("vault_name")
@click.option("--scope", type=click.Choice(["local", "global"]), default=None)
def vault_show(vault_name: str, scope: str | None) -> None:
    """Show a vault's document index.

    Bodies are not printed here — they live verbatim in the shared corpus.
    Read one with the MCP ``load_source`` tool, or sweep them all with
    ``grep``. The ``--page`` flag went with the concept-page layer on
    2026-08-04; there are no page bodies to print.
    """
    project_root = Path.cwd()
    found_scope, found_dir = _resolve_vault(
        vault_name,
        scope_hint=scope,
        project_root=project_root,  # type: ignore[arg-type]
    )

    from opentrace_agent.wiki.paths import metadata_path
    from opentrace_agent.wiki.vault import load_metadata

    meta = load_metadata(
        metadata_path(vault_name, scope=found_scope, project_root=project_root),
        name=vault_name,
    )

    click.echo(f"Vault {vault_name!r} ({found_scope})")
    click.echo(f"  Path:           {found_dir}")
    click.echo(f"  Last compiled:  {meta.last_compiled_at or '(never)'}")
    click.echo(f"  Documents:      {len(meta.sources)}")
    click.echo("")
    for src in sorted(meta.sources.values(), key=lambda s: (s.original_name.lower(), s.sha256)):
        click.echo(f"  [{src.status}] {src.original_name}")
        click.echo(f"      title:   {src.title or '(none)'}")
        click.echo(f"      summary: {src.one_line_summary or '(none)'}")


# ---------------------------------------------------------------------------
# `vault attach` (replaces `wiki backfill`)
# ---------------------------------------------------------------------------


@vault.command("attach")
@click.argument("vault_name")
@click.option("--scope", type=click.Choice(["local", "global"]), default=None)
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Graph DB to write the mirror into. Auto-discovered if omitted.",
)
def vault_attach(vault_name: str, scope: str | None, db_path: str | None) -> None:
    """Mirror an existing disk vault into the current graph.

    No LLM cost — just reads ``.vault.json`` from disk and writes the
    KnowledgeVault + KnowledgeDoc nodes and their CONTAINS edges
    into the graph. Use after a global vault has been re-compiled
    elsewhere, or after the graph DB was rebuilt.

    On name collision (same vault exists both local and global) without
    ``--scope``, prefers the local one.
    """
    project_root = Path.cwd()
    found_scope, _ = _resolve_vault(
        vault_name,
        scope_hint=scope,
        project_root=project_root,  # type: ignore[arg-type]
    )

    stats = _mirror_vault_into_graph(
        vault_name,
        scope=found_scope,
        project_root=project_root,
        db_path=db_path,
    )
    click.echo(
        f"Attached {found_scope} vault {vault_name!r}: {stats['nodes_written']} nodes, {stats['rels_written']} rels."
    )


def _mirror_vault_into_graph(
    vault_name: str,
    *,
    scope: Scope,
    project_root: Path,
    db_path: str | None = None,
) -> dict[str, int]:
    """Read a disk vault and write its KnowledgeVault + KnowledgeDoc nodes into the graph.

    Shared between ``vault attach`` and ``vault promote/demote`` so a scope
    move keeps the current project's mirror consistent without the user
    having to remember a follow-up ``vault attach``. Raises ClickException
    when no graph DB is available.

    For a global → local attach, the global corpus is copied into the
    project's corpus dir (sha-keyed, idempotent) so ``Source.corpus_path``
    resolves locally and provenance/source-body retrieval works without
    needing to walk back to ``~/.opentrace/corpus/``.
    """
    from types import SimpleNamespace

    from opentrace_agent.sources.markdown import copy_corpus_between_scopes
    from opentrace_agent.wiki.ingest.graph_writer import write_vault_to_graph
    from opentrace_agent.wiki.paths import metadata_path
    from opentrace_agent.wiki.vault import load_metadata

    meta_path = metadata_path(vault_name, scope=scope, project_root=project_root)
    meta = load_metadata(meta_path, name=vault_name)

    # Copy corpus from this vault's scope into the project so locally
    # stored Source.corpus_path values resolve under the project's
    # .opentrace/ root. For a same-scope attach this becomes an
    # existence check rather than a copy.
    try:
        corpus_map = copy_corpus_between_scopes(
            list(meta.sources.keys()),
            from_scope=scope,
            to_scope="local",
            to_project_root=project_root,
        )
    except OSError as e:
        click.echo(f"  ⚠ corpus copy failed for vault {vault_name!r}: {e}", err=True)
        corpus_map = {}
    normalized_stubs = [SimpleNamespace(sha256=sha, corpus_path=path) for sha, path in corpus_map.items()]

    graph_store = _open_graph_store(db_path)
    if graph_store is None:
        raise click.ClickException("no graph DB available — pass --db or run from inside an indexed repo")
    try:
        return write_vault_to_graph(
            graph_store,
            meta,
            normalized=normalized_stubs,
            scope=scope,
        )
    finally:
        graph_store.close()


# ---------------------------------------------------------------------------
# `vault detach`
# ---------------------------------------------------------------------------


@vault.command("detach")
@click.argument("vault_name")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Graph DB. Auto-discovered if omitted.",
)
def vault_detach(vault_name: str, db_path: str | None) -> None:
    """Remove a vault's mirror from the current graph (disk stays).

    Symmetric counterpart of ``vault attach``. Uses the existing
    ``delete_vault_from_graph`` helper which preserves Source nodes
    referenced by other attached vaults.
    """
    from opentrace_agent.wiki.ingest.graph_writer import delete_vault_from_graph

    graph_store = _open_graph_store(db_path)
    if graph_store is None:
        raise click.ClickException("no graph DB available — pass --db or run from inside an indexed repo")
    try:
        stats = delete_vault_from_graph(graph_store, vault_name)
    finally:
        graph_store.close()
    if stats.get("nodes_deleted", 0) == 0:
        click.echo(f"vault {vault_name!r} not attached to the current graph.")
    else:
        click.echo(f"Detached vault {vault_name!r}: {stats['nodes_deleted']} nodes removed.")


# ---------------------------------------------------------------------------
# `vault promote` / `vault demote`
# ---------------------------------------------------------------------------


@vault.command("promote")
@click.argument("vault_name")
def vault_promote(vault_name: str) -> None:
    """Promote a local vault to global (move from project to ~/.opentrace/vaults/).

    Moves the on-disk directory; graph mirrors that pointed at the local
    vault need to be re-attached via ``vault attach`` to pick up the new
    scope. Errors if a global vault with the same name already exists.
    """
    _move_vault_scope(vault_name, src="local", dst="global")


@vault.command("demote")
@click.argument("vault_name")
def vault_demote(vault_name: str) -> None:
    """Demote a global vault to local (move into the current project).

    Moves the on-disk directory into ``<cwd>/.opentrace/vaults/<name>/``.
    Errors if a local vault with the same name already exists in the
    current project.
    """
    _move_vault_scope(vault_name, src="global", dst="local")


def _move_vault_scope(vault_name: str, *, src: Scope, dst: Scope) -> None:
    project_root = Path.cwd()
    try:
        move_vault_dir(vault_name, src=src, dst=dst, project_root=project_root)
    except InvalidVaultName as exc:
        raise click.ClickException(str(exc))
    except (FileNotFoundError, FileExistsError) as exc:
        raise click.ClickException(str(exc))
    click.echo(f"Moved vault {vault_name!r}: {src} → {dst}")

    # Auto-refresh THIS project's graph mirror so autoprune
    # see the new scope without the user remembering a follow-up step.
    # Best-effort: if the current cwd doesn't sit in a graph (no DB), skip
    # silently — the disk move already succeeded.
    try:
        stats = _mirror_vault_into_graph(vault_name, scope=dst, project_root=project_root)
        click.echo(
            f"  Re-attached to this project's graph: {stats['nodes_written']} nodes, {stats['rels_written']} rels."
        )
    except click.ClickException:
        # No graph DB in cwd — disk move succeeded, nothing to mirror here.
        pass

    click.echo(
        f"  ⚠ Other projects with {vault_name!r} attached still see scope={src!r}. "
        f"Run `opentraceai vault attach {vault_name}` in each of those projects to "
        f"refresh their mirror, or `opentraceai vault detach {vault_name}` if they "
        "no longer need it."
    )




# ---------------------------------------------------------------------------
# vault ingest — bare-folder doc ingestion (no git repo required)
# ---------------------------------------------------------------------------


def _ingest_extensions() -> frozenset[str]:
    """The extension set ``vault ingest`` walks: ``DOC_EXTENSIONS`` + ``.json``.

    Ingest folders are data-as-docs — a fleet inventory or supplier export in
    JSON is a document here, the same way ``.csv`` already is. Ingest-specific
    by design: on a repo walk ``.json`` is code/config the code walk already
    owns, so ``index --wiki`` is unchanged.
    """
    from opentrace_agent.sources.code.directory_walker import DOC_EXTENSIONS

    return DOC_EXTENSIONS | {".json"}


def _walk_ingest_files(folder: Path) -> tuple[list[Path], list[str]]:
    """One walk, two outputs: doc files to ingest (abs paths) and the
    folder-relative names of files SKIPPED by the extension filter.

    The skip list exists because silence here is a coverage lie — a summary
    that says "14 docs indexed" over a 15-file folder reads as complete, and
    nothing downstream can reveal the file that never entered the graph.
    Directory exclusions (``.git``, ``.opentrace``, ...) are not reported:
    hiding our own index dir isn't a coverage gap.
    """
    from opentrace_agent.sources.code.directory_walker import EXCLUDED_DIRS

    exts = _ingest_extensions()
    walked: list[Path] = []
    skipped: list[str] = []
    for dirpath, dirnames, filenames in os.walk(folder):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS and not d.endswith(".egg-info")]
        for filename in sorted(filenames):
            ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            abs_file = Path(dirpath) / filename
            if ext in exts:
                walked.append(abs_file)
            else:
                skipped.append(os.path.relpath(abs_file, folder))
    return walked, skipped


def _walked_doc_shas(folder: Path) -> set[str]:
    """sha256 of every doc file currently under *folder* (full ingest-extension
    walk, no design-history exclusion) — the keep-set both prune passes use.

    MUST walk the same extension set as the ingest itself: a doc ingested
    under an extension this walk can't see would be pruned as "deleted" on
    the very next run. Deliberately ignores ``--exclude-design-history``:
    exclusion means "don't ingest these", not "delete what a previous run
    ingested", and the graph-side autoprune walks the full set too — the two
    prunes must agree on the population or they'd fight across runs.
    """
    from opentrace_agent.pipeline.autoprune import compute_walked_shas

    walked, _ = _walk_ingest_files(folder)
    return compute_walked_shas(walked)


def _prune_vault_meta_sources(meta_path: Path, vault_name: str, keep_shas: set[str]) -> int:
    """Drop ``.vault.json`` source entries for docs deleted from the folder.

    Graph-side autoprune removes their KnowledgeDoc nodes, but every compile
    re-mirrors ALL of ``meta.sources`` — so without this, a deleted doc is
    resurrected on each re-ingest and re-deleted by that run's prune, and the
    metadata grows forever. Returns the number of entries dropped.
    """
    from opentrace_agent.wiki.vault import load_metadata, save_metadata

    try:
        meta = load_metadata(meta_path, name=vault_name)
    except (OSError, ValueError):
        return 0
    doomed = [sha for sha in meta.sources if sha not in keep_shas]
    for sha in doomed:
        del meta.sources[sha]
    if doomed:
        save_metadata(meta_path, meta)
    return len(doomed)


@vault.command("ingest")
@click.argument("folder", type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path))
@click.argument("vault_name", required=False, default=None)
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Graph DB to mirror into. Auto-discovered if omitted (local scope only).",
)
@click.option(
    "--scope",
    type=click.Choice(["local", "global"]),
    default="local",
    help="Vault scope. Global vaults are written disk-only; attach them to a project later.",
)
@click.option(
    "--provider",
    type=click.Choice(["anthropic", "gemini", "openai", "kimi", "local"]),
    default=None,
    help="LLM backend for the per-doc labelling call. Auto-detected from env keys if omitted.",
)
@click.option("--api-key", default=None)
@click.option("--model", default=None)
@click.option("--base-url", default=None)
@click.option(
    "--status",
    "status_override",
    type=click.Choice(["authoritative", "design_history", "design_history_archived"]),
    default=None,
    help="Force this epistemic status on every doc, overriding the path heuristic.",
)
@click.option(
    "--exclude-design-history",
    is_flag=True,
    help="Skip proposal/spec/ADR trees and CHANGELOGs instead of labelling them.",
)
@click.option("--no-prune", is_flag=True, help="Keep vault entries for docs deleted from the folder.")
@click.option("-v", "--verbose", is_flag=True, help="Show per-file progress for cheap stages too.")
def vault_ingest(
    folder: Path,
    vault_name: str | None,
    db_path: str | None,
    scope: str,
    provider: str | None,
    api_key: str | None,
    model: str | None,
    base_url: str | None,
    status_override: str | None,
    exclude_design_history: bool,
    no_prune: bool,
    verbose: bool,
) -> None:
    """Ingest a folder of doc files into a searchable vault.

    Walks FOLDER (a Confluence/Notion/docs-site export, a downloads dir —
    any bare folder; no git repo required) for doc files (HTML, PDF, DOCX,
    Markdown, ...), normalizes each to markdown, labels it with ONE LLM call
    (a one-line summary; the title is derived from the filename), and indexes it as KnowledgeDoc
    nodes an agent can search through the graph. Bodies stay verbatim in the
    Corpus-only: bodies are stored verbatim and nothing is synthesized.

    Re-running on the same folder updates the same vault in place: unchanged
    files are skipped (content-addressed), deleted files are pruned (unless
    --no-prune). VAULT_NAME defaults to the folder's name.
    """
    from opentrace_agent.cli.main import (
        _collect_wiki_inputs,
        _echo_wiki_cost_estimate,
        _resolve_index_vault_name,
    )
    from opentrace_agent.wiki import run_compile
    from opentrace_agent.wiki.ingest.types import WikiEventKind, WikiPhase
    from opentrace_agent.wiki.paths import metadata_path, vault_dir
    from opentrace_agent.wiki.slugify import base_slug
    from opentrace_agent.wiki.vault import load_metadata, save_metadata

    folder = folder.resolve()

    # Preflight the LLM backend before touching disk or DB — a missing key
    # should fail here, not after a vault dir was created.
    if provider is None:
        provider = _autodetect_provider()

    store = None
    if scope == "local":
        if db_path is not None:
            # An explicit --db may point into a directory that doesn't exist
            # yet (a fresh scratch project, a benchmark arm dir). Create the
            # parent rather than letting the DB engine fail on it — same
            # spirit as the auto-create below. Discovery-based opens never
            # hit this (find_db only returns DBs that exist).
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        store = _open_graph_store(db_path)
        if store is None:
            # No project here yet — a dir of docs IS a valid project, no repo
            # or code walk required. Create a fresh docs-only graph next to
            # the vault so the ingest is searchable immediately instead of
            # silently downgrading to disk-only.
            from opentrace_agent.store import GraphStore

            new_db = Path.cwd() / ".opentrace" / "index.db"
            new_db.parent.mkdir(parents=True, exist_ok=True)
            store = GraphStore(str(new_db))
            click.echo(f"No graph DB found — created a docs-only graph at {new_db}.")
    else:
        click.echo(
            "Global scope: vault is written disk-only. Path stamping and "
            "doc-to-doc links are graph writes, so attached copies won't have "
            "them — use a local ingest if you need those."
        )

    try:
        # The vault must live next to the graph DB so one `.opentrace/` dir
        # holds both the graph and its vaults (same reasoning as index --wiki).
        project_root = Path(store.db_path).parent.parent if store is not None else Path.cwd()

        # `dir::<abs path>` plays the repo-id role: re-ingesting the same
        # folder finds the vault it produced before (idempotent re-runs),
        # even when the name was auto-suffixed on first creation. Repo ids
        # (`<dirname>` / `owner/repo`) never contain `::`, so no collision.
        dir_id = f"dir::{folder}"
        if not vault_name:
            vault_name = base_slug(folder.name) or "docs"
        vault_name = _resolve_index_vault_name(vault_name, scope=scope, project_root=project_root, repo_id=dir_id)

        inputs = _collect_wiki_inputs(
            folder,
            exclude_design_history=exclude_design_history,
            status_override=status_override,
            extensions=_ingest_extensions(),
        )
        _, not_walked = _walk_ingest_files(folder)
        if not inputs:
            click.echo(f"No doc files found under {folder}.")
            if not_walked:
                click.echo(f"({len(not_walked)} file(s) skipped by type: {', '.join(sorted(not_walked)[:10])})")
            return

        click.echo(f"Ingesting {len(inputs)} doc(s) from {folder} into {scope} vault {vault_name!r} ...")
        _echo_wiki_cost_estimate(provider, inputs, indent="  ")

        # LLM-bound stages get per-unit progress by default; cheap stages
        # (hashing, normalizing) stay --verbose-only. PLANNING/EXECUTING never
        # run here (corpus-only), so EXTRACTING is the only slow phase.
        progress_phases = {WikiPhase.EXTRACTING}
        summary: dict[str, int] = {
            "new": 0,
            "duplicates": 0,
            "normalize_errors": 0,
            "low_content_skipped": 0,
        }
        mirror_stats: dict[str, int] = {}
        llm_usage: dict[str, int] | None = None

        try:
            for event in run_compile(
                vault_name=vault_name,
                inputs=inputs,
                api_key=api_key,
                provider=provider,
                model=model,
                base_url=base_url,
                scope=scope,
                project_root=project_root,
                graph_store=store,
            ):
                detail = event.detail or {}
                if event.kind == WikiEventKind.STAGE_STOP:
                    if event.phase == WikiPhase.ACQUIRING:
                        summary["new"] = detail.get("new", 0)
                        summary["duplicates"] = detail.get("skipped", 0)
                    elif event.phase == WikiPhase.NORMALIZING and event.errors:
                        summary["normalize_errors"] = len(event.errors)
                summary["low_content_skipped"] += detail.get("low_content_skipped", 0)
                if "nodes_written" in detail:
                    mirror_stats = detail
                if "llm_usage" in detail:
                    llm_usage = detail["llm_usage"]

                if event.kind in (WikiEventKind.STAGE_START, WikiEventKind.STAGE_STOP, WikiEventKind.DONE):
                    click.echo(f"  {event.message}")
                elif event.kind == WikiEventKind.ERROR:
                    click.echo(f"  ERROR: {event.message}", err=True)
                elif event.kind == WikiEventKind.STAGE_PROGRESS and (verbose or event.phase in progress_phases):
                    counter = f"[{event.current}/{event.total}] " if event.total else ""
                    click.echo(f"  {counter}{event.message}")
        except RuntimeError as e:
            # Per-vault flock contention ("vault busy — another compile ...").
            raise click.ClickException(str(e)) from e

        # Bridge into the graph: stamp folder-relative paths (navigation +
        # FTS) and the authors' own doc-to-doc links. Property/edge writes
        # only — deliberately NO File twins, MIRRORS, or DOCUMENTS here:
        # there is no repo, and the KnowledgeDoc IS the document.
        stamped = doc_links = 0
        if store is not None:
            from opentrace_agent.wiki.ingest.graph_writer import (
                link_doc_to_doc_links,
                stamp_doc_paths,
            )

            named_blobs = [(inp.name, inp.data) for inp in inputs]
            stamped = stamp_doc_paths(store, named_blobs, status_override=status_override)
            doc_links = link_doc_to_doc_links(store, named_blobs)

        # Persist the folder→vault link on disk (both scopes, graph or not)
        # so a future re-ingest reuses this vault instead of suffixing anew.
        mp = metadata_path(vault_name, scope=scope, project_root=project_root)  # type: ignore[arg-type]
        try:
            meta = load_metadata(mp, name=vault_name)
            if meta.spawned_from != dir_id:
                meta.spawned_from = dir_id
                save_metadata(mp, meta)
        except OSError as exc:
            click.echo(f"  could not stamp spawned_from on {vault_name!r}: {exc}", err=True)

        pruned_sources = pruned_meta = 0
        if not no_prune:
            keep_shas = _walked_doc_shas(folder)
            if store is not None:
                from opentrace_agent.pipeline.autoprune import autoprune_after_index

                report = autoprune_after_index(
                    store,
                    walked_doc_shas=keep_shas,
                    vault_name=vault_name,
                    scope_path=folder,
                    db_path=store.db_path,
                )
                pruned_sources = report.sources_deleted
                if report.sources_deleted:
                    click.echo(
                        f"  pruned {report.sources_deleted} deleted doc(s), "
                        f"{report.corpus_files_deleted} corpus file(s)"
                    )
            pruned_meta = _prune_vault_meta_sources(mp, vault_name, keep_shas)

        _echo_ingest_summary(
            vault_name=vault_name,
            scope=scope,
            vault_path=vault_dir(vault_name, scope=scope, project_root=project_root),  # type: ignore[arg-type]
            n_inputs=len(inputs),
            summary=summary,
            mirror_stats=mirror_stats,
            stamped=stamped,
            doc_links=doc_links,
            pruned=pruned_sources or pruned_meta,
            mirrored=store is not None,
            not_walked=not_walked,
            llm_usage=llm_usage,
            provider=provider,
        )
    finally:
        if store is not None:
            store.close()


def _echo_ingest_summary(
    *,
    vault_name: str,
    scope: str,
    vault_path: Path,
    n_inputs: int,
    summary: dict[str, int],
    mirror_stats: dict[str, int],
    stamped: int,
    doc_links: int,
    pruned: int,
    mirrored: bool,
    not_walked: list[str] | None = None,
    llm_usage: dict[str, int] | None = None,
    provider: str | None = None,
) -> None:
    """The payoff screen — what the user got for the ingest, plus next step."""
    click.echo()
    click.echo(f"✓ {scope} vault {vault_name!r} — {n_inputs} doc(s) walked, {summary['new']} new")

    # Coverage must be explicit: an agent (and the person reading this) can't
    # distinguish "fully indexed" from "indexed except what was silently
    # dropped" — the exact gap the vault benchmark punished.
    if not_walked:
        from collections import Counter

        by_ext = Counter(Path(n).suffix.lower() or "(no ext)" for n in not_walked)
        counts = ", ".join(f"{c} × {ext}" for ext, c in by_ext.most_common())
        names = f" ({', '.join(sorted(not_walked))})" if len(not_walked) <= 5 else ""
        click.echo(f"  not walked (unsupported type): {counts}{names}")

    skipped_bits = []
    if summary["duplicates"]:
        skipped_bits.append(f"{summary['duplicates']} unchanged (already ingested)")
    if summary["normalize_errors"]:
        skipped_bits.append(f"{summary['normalize_errors']} failed normalization")
    if summary["low_content_skipped"]:
        skipped_bits.append(f"{summary['low_content_skipped']} empty/low-content")
    if skipped_bits:
        click.echo(f"  skipped: {', '.join(skipped_bits)}")

    if doc_links or stamped:
        click.echo(f"  graph: {stamped} path(s) stamped, {doc_links} doc-to-doc link(s) (LINKS_TO)")
    if mirror_stats:
        click.echo(
            f"  mirror: {mirror_stats.get('nodes_written', 0)} nodes, "
            f"{mirror_stats.get('rels_written', 0)} rels"
        )
    if pruned:
        click.echo(f"  pruned: {pruned} doc(s) no longer in the folder")

    # Billed actuals next to where the pre-flight ESTIMATE printed, so the two
    # confront each other on every run. Token counts are the provider's own;
    # the dollar figure converts them at our listed extraction-tier rates
    # (provider prices can drift, so it's approximate — but grounded, unlike
    # the estimate, whose assumptions once ran 6.5x stale with nothing to
    # contradict them). Absent when nothing was billed (all-duplicate re-runs)
    # or when a test injects a usage-less fake client.
    if llm_usage and provider:
        from opentrace_agent.sources._llm_common import extraction_pricing

        pricing = extraction_pricing(provider)
        cost_note = ""
        if pricing is not None:
            actual = (
                llm_usage["input_tokens"] / 1_000_000 * pricing[0]
                + llm_usage["output_tokens"] / 1_000_000 * pricing[1]
            )
            cost_note = f" · ~${actual:.2f} billed"
        click.echo(
            f"  llm: {llm_usage['input_tokens']:,} in / {llm_usage['output_tokens']:,} out "
            f"across {llm_usage['calls']} call(s){cost_note}"
        )
    click.echo(f"  on disk: {vault_path}")

    if mirrored:
        click.echo(
            "  Next: agents can search it now (`search_graph` via the OpenTrace "
            f"MCP server); browse with `opentraceai vault show {vault_name}`."
        )
    else:
        click.echo(f"  Next: attach it to a project — cd <project> && opentraceai vault attach {vault_name}")
