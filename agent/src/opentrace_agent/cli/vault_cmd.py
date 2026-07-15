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
    """Vault management — attach, detach, list, promote, demote, refresh-stale-pages."""


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
@click.option(
    "--page",
    "page_slug",
    default=None,
    help="Print the markdown body of one page (by slug) instead of the index.",
)
def vault_show(vault_name: str, scope: str | None, page_slug: str | None) -> None:
    """Show the page index for a vault, or one page's body."""
    project_root = Path.cwd()
    found_scope, found_dir = _resolve_vault(
        vault_name,
        scope_hint=scope,
        project_root=project_root,  # type: ignore[arg-type]
    )

    from opentrace_agent.wiki.paths import metadata_path, pages_dir
    from opentrace_agent.wiki.vault import load_metadata

    meta = load_metadata(
        metadata_path(vault_name, scope=found_scope, project_root=project_root),
        name=vault_name,
    )
    pages_path = pages_dir(vault_name, scope=found_scope, project_root=project_root)

    # `vault show` is read-only and runs across local + global vaults; we
    # don't trigger a disk migration here to avoid quiet side-effects on a
    # read command. Compile and attach paths handle the migration before
    # any persisted writes.

    if page_slug:
        body_path = pages_path / f"{page_slug}.md"
        if not body_path.exists():
            raise click.ClickException(f"page {page_slug!r} not found in vault {vault_name!r}")
        click.echo(body_path.read_text())
        return

    click.echo(f"Vault {vault_name!r} ({found_scope})")
    click.echo(f"  Path:           {found_dir}")
    click.echo(f"  Last compiled:  {meta.last_compiled_at or '(never)'}")
    click.echo(f"  Pages:          {len(meta.pages)}")
    click.echo("")
    for slug, p in sorted(meta.pages.items()):
        kind = p.kind or "concept"
        click.echo(f"  [{kind}] {p.slug}")
        click.echo(f"      title:   {p.title}")
        click.echo(f"      summary: {p.one_line_summary}")


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

    No LLM cost — just reads ``.vault.json`` + page files from disk and
    writes Vault/Page/Source nodes + CONTAINS/CITES/LINKS_TO edges
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
    """Read a disk vault and write its Vault/Page/Source nodes into the graph.

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
    from opentrace_agent.wiki.paths import metadata_path, pages_dir
    from opentrace_agent.wiki.vault import load_metadata

    meta_path = metadata_path(vault_name, scope=scope, project_root=project_root)
    meta = load_metadata(meta_path, name=vault_name)
    pages_path = pages_dir(vault_name, scope=scope, project_root=project_root)

    page_bodies: dict[str, str] = {}
    for slug in meta.pages.keys():
        body_path = pages_path / f"{slug}.md"
        try:
            page_bodies[slug] = body_path.read_text()
        except OSError:
            page_bodies[slug] = ""

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
            page_bodies,
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

    # Auto-refresh THIS project's graph mirror so autoprune/refresh-stale
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
# `vault refresh-stale-pages`
# ---------------------------------------------------------------------------


@vault.command("refresh-stale-pages")
@click.argument("vault_name", required=False, default=None)
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Graph DB. Auto-discovered if omitted.",
)
@click.option(
    "--provider",
    type=click.Choice(["anthropic", "gemini", "openai", "kimi", "local"]),
    default=None,
)
@click.option("--api-key", default=None)
@click.option("--model", default=None)
@click.option("--base-url", default=None)
def vault_refresh_stale_pages(
    vault_name: str | None,
    db_path: str | None,
    provider: str | None,
    api_key: str | None,
    model: str | None,
    base_url: str | None,
) -> None:
    """Re-run Plan+Execute for concept pages stamped ``stale_since``.

    Autoprune stamps pages stale when their cited Sources are removed.
    This command regenerates them against the remaining citations. No-op
    when no pages are stale.
    """
    from opentrace_agent.wiki.ingest.pipeline import refresh_stale_pages

    if provider is None:
        provider = _autodetect_provider()

    graph_store = _open_graph_store(db_path)
    if graph_store is None:
        raise click.ClickException("no graph DB available — pass --db or run from inside an indexed repo")

    try:
        regenerated = refresh_stale_pages(
            graph_store,
            vault_name=vault_name,
            provider=provider,
            api_key=api_key,
            model=model,
            base_url=base_url,
        )
    finally:
        graph_store.close()

    if regenerated == 0:
        click.echo("No stale pages found.")
    else:
        click.echo(f"Refreshed {regenerated} stale page(s).")
