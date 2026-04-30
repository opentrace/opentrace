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
    p = ensure_vault_layout("v", root=tmp_path)
    assert (p / "pages").is_dir()
    assert (p / ".compile-log").is_dir()


def test_delete_vault_removes_directory_and_returns_true(tmp_path: Path):
    vd = ensure_vault_layout("v1", root=tmp_path)
    (vd / ".vault.json").write_text("{}")
    (vd / "pages" / "foo.md").write_text("# foo")
    assert delete_vault("v1", root=tmp_path) is True
    assert not vd.exists()


def test_delete_vault_returns_false_when_missing(tmp_path: Path):
    assert delete_vault("nope", root=tmp_path) is False


def test_delete_vault_rejects_invalid_name(tmp_path: Path):
    with pytest.raises(InvalidVaultName):
        delete_vault("../etc", root=tmp_path)


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
