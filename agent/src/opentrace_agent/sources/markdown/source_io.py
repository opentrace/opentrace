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

"""On-disk corpus storage for ingested document bodies.

Doc ingestion writes each markitdown-normalized body to
``.opentrace/corpus/<sha>.md`` and stores only ``corpus_path`` on the graph
node. Bodies do not live in the graph: LadybugDB caps STRING properties at
~4 KB and doc bodies typically run 5–20 KB, so disk is the source of truth for
content and the graph holds metadata plus a reference. This also keeps node
fetches cheap — a body never rides along on ``/api/graph`` or ``get_node``.

``corpus_path`` is stored as a path relative to ``.opentrace/`` so the
graph database stays portable across machines / worktrees.

The corpus is scope-aware: :func:`corpus_dir_for_scope` resolves it for a
local or global vault, and :func:`copy_corpus_between_scopes` moves bodies
sha-by-sha when a vault is attached, promoted, or demoted.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Literal

CORPUS_SUBDIR = "corpus"

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


def relative_corpus_path(doc_sha: str) -> str:
    """The ``corpus_path`` string stored on the KnowledgeDoc — stable, portable.

    Pass the bare sha256, NOT the node id: the node is ``corpus::<sha>`` but
    its body is ``corpus/<sha>.md``. Passing the id yields a different,
    self-consistent filename, so the mistake resolves fine and silently
    establishes a second naming convention in the same directory.
    """
    return f"{CORPUS_SUBDIR}/{_safe_corpus_filename(doc_sha)}"


def _safe_corpus_filename(doc_sha: str) -> str:
    # A sha256 is hex, so neither character can occur; the substitution is
    # retained only so a non-sha id can never escape the corpus directory.
    safe = doc_sha.replace(":", "_").replace("/", "_")
    return f"{safe}.md"


def corpus_dir_for_scope(
    scope: Scope,
    project_root: Path | str | None = None,
) -> Path:
    """Resolve the on-disk corpus directory for *scope*.

    The corpus is the post-markitdown body of each ``KnowledgeDoc``, stored
    at ``<base>/corpus/<sha>.md``. ``<base>`` is scope-dependent so a
    global vault's corpus survives across the projects that attach it:

    * ``"local"`` → ``<project_root>/.opentrace/corpus/`` (project_root
      defaults to ``cwd``).
    * ``"global"`` → ``<global vault root>/../corpus/`` — typically
      ``~/.opentrace/corpus/`` but follows ``$OT_VAULT_ROOT`` when set.
    """
    if scope == "global":
        # Lazy import — wiki.paths depends on this module's siblings
        # (sources.markdown) for the corpus helpers, and an import at
        # module-top would risk a cycle.
        from opentrace_agent.wiki.paths import vault_root

        return vault_root(scope="global").parent / CORPUS_SUBDIR
    base = Path(project_root) if project_root is not None else Path.cwd()
    return (base / ".opentrace" / CORPUS_SUBDIR).resolve()


def write_corpus_markdown_to(
    corpus_directory: Path,
    doc_sha: str,
    markdown_text: str,
) -> str:
    """Write *markdown_text* to ``<corpus_directory>/<sha>.md``.

    Returns the same stable relative path string that :func:`relative_corpus_path`
    produces, so the value can be stored as the KnowledgeDoc's ``corpus_path``
    regardless of which scope's corpus directory the file actually lives in.
    """
    full = corpus_directory / _safe_corpus_filename(doc_sha)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(markdown_text, encoding="utf-8")
    return relative_corpus_path(doc_sha)


def copy_corpus_between_scopes(
    doc_shas: list[str],
    *,
    from_scope: Scope,
    to_scope: Scope,
    from_project_root: Path | str | None = None,
    to_project_root: Path | str | None = None,
) -> dict[str, str]:
    """Copy corpus files from one scope's dir to another.

    Used by ``vault attach`` to bring a global vault's document bodies into
    the attaching project's corpus so retrieval / provenance works
    end-to-end without keeping references to ``~/.opentrace/corpus/``.

    Returns a ``{doc_sha: relative_corpus_path}`` map for every document
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
    for sid in doc_shas:
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
