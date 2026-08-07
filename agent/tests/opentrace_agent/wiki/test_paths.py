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

from pathlib import Path

import pytest

from opentrace_agent.wiki.paths import (
    InvalidVaultName,
    delete_vault,
    ensure_vault_layout,
    list_vaults,
    move_vault_dir,
    unique_vault_name,
    validate_vault_name,
    vault_dir,
)


def test_validate_accepts_safe_name():
    assert validate_vault_name("safe-name_1") == "safe-name_1"


@pytest.mark.parametrize("bad", ["", ".", "..", "../etc", "with space", "a" * 65, "/abs"])
def test_validate_rejects_bad_names(bad: str):
    with pytest.raises(InvalidVaultName):
        validate_vault_name(bad)


def test_vault_dir_under_root(tmp_path: Path):
    p = vault_dir("foo", root=tmp_path)
    assert p == (tmp_path / "foo").resolve()


def test_ensure_vault_layout_creates_subdirs(tmp_path: Path):
    """A vault dir is metadata + audit log only. The ``pages/`` dir it also
    created went with the concept-page layer on 2026-08-04 — document bodies
    live in the shared, sha-keyed corpus dir, never under the vault."""
    p = ensure_vault_layout("v", root=tmp_path)
    assert (p / ".compile-log").is_dir()
    assert not (p / "pages").exists()


def test_delete_vault_removes_directory_and_returns_true(tmp_path: Path):
    vd = ensure_vault_layout("v1", root=tmp_path)
    (vd / ".vault.json").write_text("{}")
    (vd / ".compile-log" / "run.json").write_text("{}")
    assert delete_vault("v1", root=tmp_path) is True
    assert not vd.exists()


def test_delete_vault_returns_false_when_missing(tmp_path: Path):
    assert delete_vault("nope", root=tmp_path) is False


def test_delete_vault_rejects_invalid_name(tmp_path: Path):
    with pytest.raises(InvalidVaultName):
        delete_vault("../etc", root=tmp_path)


def test_move_vault_dir_local_to_global(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))
    src = ensure_vault_layout("v1", scope="local", project_root=tmp_path)
    (src / ".vault.json").write_text("{}")

    old_src, new_dst = move_vault_dir("v1", src="local", dst="global", project_root=tmp_path)
    assert not old_src.exists()
    assert new_dst == vault_dir("v1", scope="global", project_root=tmp_path)
    assert (new_dst / ".vault.json").exists()


def test_move_vault_dir_missing_source(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))
    with pytest.raises(FileNotFoundError):
        move_vault_dir("nope", src="local", dst="global", project_root=tmp_path)


def test_move_vault_dir_conflicts_with_existing_dst(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))
    src = ensure_vault_layout("dup", scope="local", project_root=tmp_path)
    (src / ".vault.json").write_text("{}")
    ensure_vault_layout("dup", scope="global", project_root=tmp_path)

    with pytest.raises(FileExistsError):
        move_vault_dir("dup", src="local", dst="global", project_root=tmp_path)
    # Source left intact on conflict.
    assert (src / ".vault.json").exists()


def test_move_vault_dir_rejects_invalid_name(tmp_path: Path):
    with pytest.raises(InvalidVaultName):
        move_vault_dir("../etc", src="local", dst="global", project_root=tmp_path)


def test_ensure_vault_layout_writes_gitignore_at_root(tmp_path: Path):
    ensure_vault_layout("v1", root=tmp_path)
    gi = tmp_path / ".gitignore"
    assert gi.exists()
    content = gi.read_text()
    assert "*.lock" in content
    assert ".compile-log/" in content


def test_ensure_vault_layout_does_not_overwrite_existing_gitignore(tmp_path: Path):
    tmp_path.mkdir(exist_ok=True)
    (tmp_path / ".gitignore").write_text("# pre-existing user content\n")
    ensure_vault_layout("v1", root=tmp_path)
    assert (tmp_path / ".gitignore").read_text() == "# pre-existing user content\n"


def test_list_vaults_skips_hidden_files_and_empty_dirs(tmp_path: Path):
    real = tmp_path / "real"
    real.mkdir()
    (real / ".vault.json").write_text("{}")
    (tmp_path / ".hidden").mkdir()
    (tmp_path / "file.md").write_text("x")
    # A vault directory without metadata (e.g. failed initial compile) is
    # invisible to the listing.
    (tmp_path / "empty").mkdir()
    assert list_vaults(root=tmp_path) == ["real"]


class TestUniqueVaultName:
    def _make(self, name, scope, *, project_root, global_root):
        import os

        from opentrace_agent.wiki.paths import ensure_vault_layout, metadata_path

        os.environ["OT_VAULT_ROOT"] = str(global_root)
        ensure_vault_layout(name, scope=scope, project_root=project_root)
        # A dir only counts as a vault once it has .vault.json.
        metadata_path(name, scope=scope, project_root=project_root).write_text("{}")

    def test_free_name_unchanged(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "g"))
        assert unique_vault_name("flask", project_root=tmp_path / "p") == "flask"

    def test_suffixes_when_taken_in_local(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "g"))
        pr = tmp_path / "p"
        self._make("flask", "local", project_root=pr, global_root=tmp_path / "g")
        assert unique_vault_name("flask", project_root=pr) == "flask-1"

    def test_suffixes_across_scopes(self, tmp_path, monkeypatch):
        # A global "flask" must push a NEW local vault to "flask-1" (the two
        # scopes never share a label).
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "g"))
        pr = tmp_path / "p"
        self._make("flask", "global", project_root=pr, global_root=tmp_path / "g")
        assert unique_vault_name("flask", project_root=pr) == "flask-1"

    def test_increments_past_existing_suffixes(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "g"))
        pr = tmp_path / "p"
        self._make("flask", "local", project_root=pr, global_root=tmp_path / "g")
        self._make("flask-1", "global", project_root=pr, global_root=tmp_path / "g")
        assert unique_vault_name("flask", project_root=pr) == "flask-2"
