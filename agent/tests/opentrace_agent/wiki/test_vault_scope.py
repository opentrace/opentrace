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

"""Tests for the local/global vault scope resolution in ``wiki/paths.py``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from opentrace_agent.wiki.paths import (
    LOCAL_VAULT_DIRNAME,
    ensure_vault_layout,
    list_vaults,
    list_vaults_with_scope,
    resolve_vault_scope,
    vault_dir,
    vault_root,
)


def _make_vault(scope: str, name: str, *, project_root: Path, global_root: Path) -> Path:
    """Create a minimal valid vault on disk under the chosen scope."""
    if scope == "local":
        vd = ensure_vault_layout(name, scope=scope, project_root=project_root)
    else:
        vd = ensure_vault_layout(name, root=global_root)
    (vd / ".vault.json").write_text(
        json.dumps({"name": name, "last_compiled_at": "2026-01-01T00:00:00+00:00", "pages": {}, "sources": {}})
    )
    return vd


@pytest.fixture
def envs(tmp_path, monkeypatch):
    """A project dir + a global root, isolated per test."""
    project = tmp_path / "myproject"
    project.mkdir()
    global_root = tmp_path / "global"
    global_root.mkdir()
    monkeypatch.setenv("OT_VAULT_ROOT", str(global_root))
    monkeypatch.chdir(project)
    return project, global_root


class TestVaultRoot:
    def test_local_root_under_project(self, envs):
        project, _ = envs
        root = vault_root(scope="local", project_root=project)
        assert root == (project / LOCAL_VAULT_DIRNAME).resolve()

    def test_global_root_from_env(self, envs):
        _, global_root = envs
        root = vault_root(scope="global")
        assert root == global_root.resolve()

    def test_explicit_override_wins(self, envs, tmp_path):
        custom = tmp_path / "custom"
        custom.mkdir()
        # override beats both env and scope
        assert vault_root(custom, scope="global") == custom.resolve()


class TestResolveVaultScope:
    def test_local_only(self, envs):
        project, global_root = envs
        _make_vault("local", "research", project_root=project, global_root=global_root)

        found = resolve_vault_scope("research", project_root=project)
        assert found is not None
        scope, vd = found
        assert scope == "local"
        assert vd.is_relative_to(project)

    def test_global_only(self, envs):
        project, global_root = envs
        _make_vault("global", "research", project_root=project, global_root=global_root)

        found = resolve_vault_scope("research", project_root=project)
        assert found is not None
        scope, vd = found
        assert scope == "global"

    def test_collision_prefers_local(self, envs):
        project, global_root = envs
        _make_vault("local", "research", project_root=project, global_root=global_root)
        _make_vault("global", "research", project_root=project, global_root=global_root)

        found = resolve_vault_scope("research", project_root=project)
        assert found is not None
        scope, _ = found
        assert scope == "local"

    def test_collision_with_prefer_global(self, envs):
        project, global_root = envs
        _make_vault("local", "research", project_root=project, global_root=global_root)
        _make_vault("global", "research", project_root=project, global_root=global_root)

        found = resolve_vault_scope("research", project_root=project, prefer="global")
        assert found is not None
        scope, _ = found
        assert scope == "global"

    def test_not_found(self, envs):
        project, _ = envs
        assert resolve_vault_scope("ghost", project_root=project) is None


class TestListVaultsWithScope:
    def test_lists_locals_first_then_globals(self, envs):
        project, global_root = envs
        _make_vault("local", "alpha", project_root=project, global_root=global_root)
        _make_vault("local", "beta", project_root=project, global_root=global_root)
        _make_vault("global", "gamma", project_root=project, global_root=global_root)

        pairs = list_vaults_with_scope(project_root=project)
        # locals first, alphabetical within each scope
        assert pairs == [("local", "alpha"), ("local", "beta"), ("global", "gamma")]

    def test_global_only_listing(self, envs):
        project, global_root = envs
        _make_vault("local", "alpha", project_root=project, global_root=global_root)
        _make_vault("global", "gamma", project_root=project, global_root=global_root)

        globals_ = list_vaults(scope="global", project_root=project)
        assert globals_ == ["gamma"]


class TestVaultDir:
    def test_local_directory_isolated_per_project(self, envs, tmp_path):
        project_a, _ = envs
        project_b = tmp_path / "other-project"
        project_b.mkdir()

        a = vault_dir("research", scope="local", project_root=project_a)
        b = vault_dir("research", scope="local", project_root=project_b)
        assert a != b
        assert a.is_relative_to(project_a)
        assert b.is_relative_to(project_b)

    def test_global_directory_under_env_root(self, envs):
        project, global_root = envs
        gd = vault_dir("research", scope="global", project_root=project)
        assert gd.is_relative_to(global_root)
