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

"""On-disk corpus storage for ingested ``Source`` nodes.

Each ``opentraceai ingest`` writes the markitdown output to
``.opentrace/corpus/<source_id>.md`` and stores ``corpus_path`` on the
``Source`` node instead of inlining the body. Keeps node fetches cheap (the
markdown body never rides along on ``/api/graph`` or ``get_node``) and lets
the LLM-extraction stage stream the body off disk on demand.

The two seams are tiny:

* :func:`write_source_markdown` — called by ``ingest_cmd`` after conversion.
* :func:`load_source_markdown` — called by the extractor (and any other
  consumer) to reconstruct an :class:`AnnotatedMarkdown` from a stored node.

``corpus_path`` is stored as a path relative to ``.opentrace/`` so the
graph database stays portable across machines / worktrees.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Literal

from .loader import AnnotatedMarkdown

CORPUS_SUBDIR = "corpus"
ENTITY_CACHE_SUBDIR = "entity_cache"

Scope = Literal["local", "global"]


def _opentrace_dir(db_path: str | Path) -> Path:
    """The ``.opentrace/`` directory containing the index DB.

    The DB is typically at ``.opentrace/index.db``; we anchor everything else
    (corpus dir, future per-repo extras) to its parent so a custom ``--db``
    keeps colocated artefacts.
    """
    return Path(db_path).resolve().parent


def corpus_dir(db_path: str | Path) -> Path:
    """Filesystem location of the corpus directory for *db_path*."""
    return _opentrace_dir(db_path) / CORPUS_SUBDIR


def entity_cache_dir(db_path: str | Path) -> Path:
    """Filesystem location of the entity-extraction cache for *db_path*.

    Sits next to the corpus dir (anchored on the DB's ``.opentrace/``). Holds
    one ``<sha>.json`` per extracted source so re-indexing unchanged docs can
    skip the LLM call. Path-only helper — no graph-type dependency.
    """
    return _opentrace_dir(db_path) / ENTITY_CACHE_SUBDIR


def relative_corpus_path(source_id: str) -> str:
    """The string stored on the Source node — stable, portable."""
    safe = source_id.replace(":", "_").replace("/", "_")
    return f"{CORPUS_SUBDIR}/{safe}.md"


def _safe_corpus_filename(source_id: str) -> str:
    safe = source_id.replace(":", "_").replace("/", "_")
    return f"{safe}.md"


def corpus_dir_for_scope(
    scope: Scope,
    project_root: Path | str | None = None,
) -> Path:
    """Resolve the on-disk corpus directory for *scope*.

    The corpus is the post-markitdown body of each ``Source`` node, stored
    at ``<base>/corpus/<sha>.md``. ``<base>`` is scope-dependent so a
    global vault's corpus survives across the projects that attach it:

    * ``"local"`` → ``<project_root>/.opentrace/corpus/`` (project_root
      defaults to ``cwd``).
    * ``"global"`` → ``<global vault root>/../corpus/`` — typically
      ``~/.opentrace/corpus/`` but follows ``$OT_VAULT_ROOT`` when set.
    """
    if scope == "global":
        # Lazy import — wiki.paths depends on this module's siblings
        # (sources.markdown) for write_corpus_markdown, and an import at
        # module-top would risk a cycle.
        from opentrace_agent.wiki.paths import vault_root

        return vault_root(scope="global").parent / CORPUS_SUBDIR
    base = Path(project_root) if project_root is not None else Path.cwd()
    return (base / ".opentrace" / CORPUS_SUBDIR).resolve()


def write_corpus_markdown_to(
    corpus_directory: Path,
    source_id: str,
    markdown_text: str,
) -> str:
    """Write *markdown_text* to ``<corpus_directory>/<safe_id>.md``.

    Returns the same stable relative path string that :func:`relative_corpus_path`
    produces, so the value can be stored on the ``Source`` node regardless
    of which scope's corpus directory the file actually lives in.
    """
    full = corpus_directory / _safe_corpus_filename(source_id)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(markdown_text, encoding="utf-8")
    return relative_corpus_path(source_id)


def write_corpus_markdown(
    db_path: str | Path,
    source_id: str,
    markdown_text: str,
) -> str:
    """Write *markdown_text* to ``corpus/<id>.md``; return the relative path.

    Low-level seam used by both ``ingest_cmd`` (via :func:`write_source_markdown`)
    and the wiki ingest pipeline. Overwrites existing files so re-ingesting
    the same source converges.
    """
    return write_corpus_markdown_to(corpus_dir(db_path), source_id, markdown_text)


def copy_corpus_between_scopes(
    source_ids: list[str],
    *,
    from_scope: Scope,
    to_scope: Scope,
    from_project_root: Path | str | None = None,
    to_project_root: Path | str | None = None,
) -> dict[str, str]:
    """Copy corpus files from one scope's dir to another.

    Used by ``vault attach`` to bring a global vault's source bodies into
    the attaching project's corpus so retrieval / provenance works
    end-to-end without keeping references to ``~/.opentrace/corpus/``.

    Returns a ``{source_id: relative_corpus_path}`` map for every source
    whose corpus file ended up at the destination (already-present files
    are included, missing-at-source files are skipped). Safe to call when
    both scopes resolve to the same dir — it becomes an existence check.
    """
    src_dir = corpus_dir_for_scope(from_scope, project_root=from_project_root)
    dst_dir = corpus_dir_for_scope(to_scope, project_root=to_project_root)
    same_dir = src_dir.resolve(strict=False) == dst_dir.resolve(strict=False)
    if not same_dir:
        dst_dir.mkdir(parents=True, exist_ok=True)
    out: dict[str, str] = {}
    for sid in source_ids:
        filename = _safe_corpus_filename(sid)
        src_file = src_dir / filename
        dst_file = dst_dir / filename
        if same_dir:
            if src_file.exists():
                out[sid] = relative_corpus_path(sid)
            continue
        if not src_file.exists():
            continue
        if not dst_file.exists():
            shutil.copyfile(src_file, dst_file)
        out[sid] = relative_corpus_path(sid)
    return out


def write_source_markdown(
    db_path: str | Path,
    source_id: str,
    annotated: AnnotatedMarkdown,
) -> str:
    """Write the markdown body to disk; return the relative path to store on the node."""
    return write_corpus_markdown(db_path, source_id, annotated.markdown)


def load_source_markdown(
    db_path: str | Path,
    source_node: dict[str, Any],
) -> AnnotatedMarkdown:
    """Reconstruct :class:`AnnotatedMarkdown` from a stored Source node.

    Reads the markdown body from ``corpus/<source_id>.md`` and pulls
    provenance fields out of ``source_node.properties``. Raises
    ``FileNotFoundError`` if the corpus file is missing — callers should treat
    that as data corruption, not a routine failure.
    """
    props = source_node.get("properties") or {}
    rel = props.get("corpus_path")
    if not rel:
        raise ValueError(
            f"Source node {source_node.get('id')!r} has no corpus_path property "
            "(it was likely written by an older OpenTrace version)."
        )
    full = _opentrace_dir(db_path) / rel
    if not full.exists():
        raise FileNotFoundError(f"Corpus file missing for Source {source_node.get('id')!r}: {full}")
    return AnnotatedMarkdown(
        markdown=full.read_text(encoding="utf-8"),
        source_uri=str(props.get("source_uri") or ""),
        source_type=str(props.get("source_type") or "unknown"),
        title=str(props.get("title")) if props.get("title") else None,
        fetched_at=str(props.get("fetched_at") or ""),
    )
