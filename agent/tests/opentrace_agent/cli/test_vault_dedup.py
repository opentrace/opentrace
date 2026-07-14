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

"""Vault-name de-duplication + re-index idempotency (CLI `index --wiki`)."""

from __future__ import annotations

from opentrace_agent.cli.main import _resolve_index_vault_name
from opentrace_agent.wiki.paths import ensure_vault_layout, metadata_path
from opentrace_agent.wiki.vault import VaultMetadata, save_metadata


def _make_vault(name, scope, *, project_root, spawned_from=None):
    ensure_vault_layout(name, scope=scope, project_root=project_root)
    save_metadata(
        metadata_path(name, scope=scope, project_root=project_root),
        VaultMetadata(name=name, spawned_from=spawned_from),
    )


class TestResolveIndexVaultName:
    def test_new_name_used_verbatim(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "g"))
        pr = tmp_path / "p"
        assert _resolve_index_vault_name("flask", scope="local", project_root=pr, repo_id="flask") == "flask"

    def test_cross_scope_collision_suffixes_new_vault(self, tmp_path, monkeypatch):
        # A global "flask" (a *different* vault) forces this repo's new local
        # vault to "flask-1".
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "g"))
        pr = tmp_path / "p"
        _make_vault("flask", "global", project_root=pr, spawned_from="other-repo")
        assert _resolve_index_vault_name("flask", scope="local", project_root=pr, repo_id="flask") == "flask-1"

    def test_reindex_reuses_repo_vault_even_when_suffixed(self, tmp_path, monkeypatch):
        # Simulate: first run made "flask-1" (because global "flask" existed)
        # and stamped spawned_from. A re-index must reuse "flask-1", NOT mint
        # "flask-2".
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "g"))
        pr = tmp_path / "p"
        _make_vault("flask", "global", project_root=pr, spawned_from="other-repo")
        _make_vault("flask-1", "local", project_root=pr, spawned_from="flask")
        assert _resolve_index_vault_name("flask", scope="local", project_root=pr, repo_id="flask") == "flask-1"

    def test_adopts_legacy_same_name_vault(self, tmp_path, monkeypatch):
        # A local "flask" compiled before spawned_from tracking (no stamp) is
        # updated in place, matching historical append-on-same-name behaviour.
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "g"))
        pr = tmp_path / "p"
        _make_vault("flask", "local", project_root=pr, spawned_from=None)
        assert _resolve_index_vault_name("flask", scope="local", project_root=pr, repo_id="flask") == "flask"
