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

"""Vault path resolution + path-traversal validation.

Vaults have two scopes:

* **local** — live at ``<project>/.opentrace/vaults/<name>/``. Visible only
  to graphs that share the same project root. Default when compiling a new
  vault via ``index --wiki``.
* **global** — live at ``~/.opentrace/vaults/<name>/`` (override with
  ``$OT_VAULT_ROOT``). Visible to any project on the machine.

The disk path encodes the scope — there's no name prefix or tag stored in
the path itself. ``vault attach`` resolves a name by checking local first,
then global; ``--scope`` overrides on collision.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Literal

VAULT_NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{1,64}$")
DEFAULT_GLOBAL_VAULT_ROOT = Path.home() / ".opentrace" / "vaults"
LOCAL_VAULT_DIRNAME = ".opentrace/vaults"

# Backward-compat alias — pre-scope code referenced this. Maps to global.
DEFAULT_VAULT_ROOT = DEFAULT_GLOBAL_VAULT_ROOT

Scope = Literal["local", "global"]


class InvalidVaultName(ValueError):
    pass


def vault_root(
    override: Path | str | None = None,
    *,
    scope: Scope = "global",
    project_root: Path | str | None = None,
) -> Path:
    """Return the root directory under which vaults of *scope* live.

    Explicit *override* always wins (used by tests + advanced callers).
    Otherwise:

    * ``scope="local"`` → ``<project_root>/.opentrace/vaults`` (project_root
      defaults to cwd).
    * ``scope="global"`` → ``$OT_VAULT_ROOT`` if set, otherwise
      ``~/.opentrace/vaults``.
    """
    if override is not None:
        return Path(override).expanduser().resolve()
    if scope == "local":
        base = Path(project_root) if project_root is not None else Path.cwd()
        return (base / LOCAL_VAULT_DIRNAME).resolve()
    env = os.environ.get("OT_VAULT_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    return DEFAULT_GLOBAL_VAULT_ROOT.resolve()


def validate_vault_name(name: str) -> str:
    """Validate a vault name. Reject empty, too long, traversal, special chars."""
    if not name or name in (".", ".."):
        raise InvalidVaultName(f"invalid vault name: {name!r}")
    if not VAULT_NAME_RE.match(name):
        raise InvalidVaultName(f"vault name must match {VAULT_NAME_RE.pattern}, got {name!r}")
    return name


def vault_dir(
    name: str,
    root: Path | str | None = None,
    *,
    scope: Scope = "global",
    project_root: Path | str | None = None,
) -> Path:
    """Return the on-disk path for a named vault, asserting it stays under the root.

    *root* is an explicit override; when omitted, *scope* + *project_root*
    select between local and global roots via :func:`vault_root`.
    """
    name = validate_vault_name(name)
    root_path = vault_root(root, scope=scope, project_root=project_root)
    candidate = (root_path / name).resolve()
    try:
        candidate.relative_to(root_path)
    except ValueError as e:
        raise InvalidVaultName(f"vault path escapes root: {candidate}") from e
    return candidate


def pages_dir(
    name: str,
    root: Path | str | None = None,
    *,
    scope: Scope = "global",
    project_root: Path | str | None = None,
) -> Path:
    return vault_dir(name, root, scope=scope, project_root=project_root) / "pages"


def metadata_path(
    name: str,
    root: Path | str | None = None,
    *,
    scope: Scope = "global",
    project_root: Path | str | None = None,
) -> Path:
    return vault_dir(name, root, scope=scope, project_root=project_root) / ".vault.json"


def compile_log_dir(
    name: str,
    root: Path | str | None = None,
    *,
    scope: Scope = "global",
    project_root: Path | str | None = None,
) -> Path:
    return vault_dir(name, root, scope=scope, project_root=project_root) / ".compile-log"


def unique_vault_name(
    name: str,
    *,
    project_root: Path | str | None = None,
) -> str:
    """Return a vault name that collides with no existing vault in *either* scope.

    A vault name must be unique across both local and global roots so the two
    scopes never show two different vaults under the same label (the confusing
    ``flask`` local + ``flask`` global situation). If *name* is unused it is
    returned unchanged; otherwise a filesystem-style ``-1``, ``-2``, … suffix
    is appended until a free name is found (kept within the 64-char limit).

    Callers that intend to *update* an existing vault (append, or re-index of a
    repo that already owns a vault) must resolve that vault's name first and
    NOT route it through here — this only mints names for genuinely new vaults.
    """
    base = validate_vault_name(name)

    def taken(candidate: str) -> bool:
        return resolve_vault_scope(candidate, project_root=project_root) is not None

    if not taken(base):
        return base
    i = 1
    while True:
        suffix = f"-{i}"
        # Trim the base so "<base><suffix>" respects VAULT_NAME_RE's 64-char cap.
        candidate = base[: 64 - len(suffix)] + suffix
        if not taken(candidate):
            return candidate
        i += 1


def resolve_vault_scope(
    name: str,
    *,
    project_root: Path | str | None = None,
    prefer: Scope | None = None,
) -> tuple[Scope, Path] | None:
    """Find an existing vault by name, returning ``(scope, vault_dir)``.

    Checks local first (under *project_root*), then global. *prefer* forces a
    specific scope when both have the same name. Returns ``None`` when the
    vault doesn't exist in either location.
    """
    name = validate_vault_name(name)
    candidates: list[Scope] = [prefer] if prefer is not None else ["local", "global"]
    for scope in candidates:
        try:
            vd = vault_dir(name, scope=scope, project_root=project_root)
        except InvalidVaultName:
            continue
        if (vd / ".vault.json").exists():
            return scope, vd
    return None


_VAULT_ROOT_GITIGNORE = """\
# OpenTrace vault data — generated by `opentraceai index --wiki`.
# Lock files and per-compile audit logs are noise; the actual pages and
# metadata can be version-controlled if desired.
*.lock
.compile-log/
"""


def _ensure_vault_root_gitignore(root: Path) -> None:
    """Write a ``.gitignore`` into the vault root if one doesn't already exist.

    Mostly defensive: vaults usually live in ``~/.opentrace/`` outside any
    repo. But if a user opts into ``OT_VAULT_ROOT=./.opentrace/vaults``
    inside a project, this keeps ``.lock`` files and the audit logs out of
    their git status.
    """
    gi = root / ".gitignore"
    if not gi.exists():
        gi.write_text(_VAULT_ROOT_GITIGNORE)


def ensure_vault_layout(
    name: str,
    root: Path | str | None = None,
    *,
    scope: Scope = "global",
    project_root: Path | str | None = None,
) -> Path:
    """Create the vault directory layout (pages/, .compile-log/) if missing."""
    root_path = vault_root(root, scope=scope, project_root=project_root)
    root_path.mkdir(parents=True, exist_ok=True)
    _ensure_vault_root_gitignore(root_path)
    vd = vault_dir(name, root, scope=scope, project_root=project_root)
    vd.mkdir(parents=True, exist_ok=True)
    (vd / "pages").mkdir(exist_ok=True)
    (vd / ".compile-log").mkdir(exist_ok=True)
    return vd


def delete_vault(
    name: str,
    root: Path | str | None = None,
    *,
    scope: Scope = "global",
    project_root: Path | str | None = None,
) -> bool:
    """Recursively delete the vault directory for *name*.

    Returns ``True`` if a directory existed and was removed, ``False`` if
    no such vault was present. Validates *name* via :func:`vault_dir` so
    the path can never escape the configured vault root.
    """
    vd = vault_dir(name, root, scope=scope, project_root=project_root)
    if not vd.exists():
        return False
    if not vd.is_dir():
        return False
    shutil.rmtree(vd)
    return True


def move_vault_dir(
    name: str,
    *,
    src: Scope,
    dst: Scope,
    project_root: Path | str | None = None,
) -> tuple[Path, Path]:
    """Move a vault's on-disk directory from one scope to another.

    Shared by ``vault promote`` / ``vault demote`` (CLI) and the
    ``/api/vaults/{name}/promote`` REST route so the disk move stays in one
    place. Only touches the vault directory itself — corpus bodies (a
    separate ``.opentrace/corpus/`` tree) are handled by the caller via
    :func:`sources.markdown.copy_corpus_between_scopes`.

    Returns ``(src_dir, dst_dir)``. Raises:

    * :class:`InvalidVaultName` — *name* fails validation.
    * :class:`FileNotFoundError` — no *src*-scoped vault of that name.
    * :class:`FileExistsError` — a *dst*-scoped vault of that name already
      exists (the move would clobber it).
    """
    src_dir = vault_dir(name, scope=src, project_root=project_root)
    dst_dir = vault_dir(name, scope=dst, project_root=project_root)
    if not (src_dir / ".vault.json").exists():
        raise FileNotFoundError(f"no {src} vault named {name!r} (expected {src_dir})")
    if dst_dir.exists():
        raise FileExistsError(f"cannot move {src}→{dst}: a {dst} vault named {name!r} already exists at {dst_dir}")
    dst_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src_dir), str(dst_dir))
    return src_dir, dst_dir


def list_vaults(
    root: Path | str | None = None,
    *,
    scope: Scope = "global",
    project_root: Path | str | None = None,
) -> list[str]:
    """Return names of compiled vaults under the resolved root for *scope*.

    A directory only counts as a "vault" once it has a ``.vault.json`` —
    so a compile that errored before reaching the Persist stage doesn't
    leave an empty placeholder cluttering the sidebar.
    """
    root_path = vault_root(root, scope=scope, project_root=project_root)
    if not root_path.exists():
        return []
    out: list[str] = []
    for entry in sorted(root_path.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        try:
            validate_vault_name(entry.name)
        except InvalidVaultName:
            continue
        if not (entry / ".vault.json").exists():
            continue
        out.append(entry.name)
    return out


def list_vaults_with_scope(
    project_root: Path | str | None = None,
) -> list[tuple[Scope, str]]:
    """List local + global vaults visible from *project_root*.

    Returns ``[(scope, name), ...]`` ordered local-first, alphabetic within
    each scope. Used by ``vault list`` to render a single unified view.
    """
    out: list[tuple[Scope, str]] = []
    for name in list_vaults(scope="local", project_root=project_root):
        out.append(("local", name))
    for name in list_vaults(scope="global", project_root=project_root):
        out.append(("global", name))
    return out
