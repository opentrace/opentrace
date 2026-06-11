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

"""Parity tests for the shared LLM backend registry.

Both ingestion paths (wiki + generic markdown) read defaults from
``sources/_llm_common.py``. These tests guard the contract: the same
provider name resolves to the same model / env vars / pricing on both
surfaces. Regressions here usually mean somebody added a hardcoded
default in ``wiki/llm.py`` or ``sources/markdown/clients.py`` instead
of reading from BACKENDS.
"""

from __future__ import annotations

import pytest

from opentrace_agent.sources._llm_common import (
    _BACKEND_PRIORITY,
    BACKENDS,
    canonical_backend,
    resolve_api_key,
    resolve_base_url,
    resolve_model,
)


class TestCanonicalBackend:
    def test_canonical_names_pass_through(self):
        assert canonical_backend("anthropic") == "anthropic"
        assert canonical_backend("gemini") == "gemini"
        assert canonical_backend("openai") == "openai"
        assert canonical_backend("kimi") == "kimi"
        assert canonical_backend("local") == "local"

    def test_legacy_aliases_resolve(self):
        # The experiment's first ingest CLI accepted these names.
        assert canonical_backend("claude") == "anthropic"
        assert canonical_backend("ollama") == "local"

    def test_unknown_passes_through(self):
        # Unknown names pass unchanged so callers can raise their own error.
        assert canonical_backend("totally-fake") == "totally-fake"


class TestBackendRegistry:
    def test_canonical_names_all_present(self):
        expected = {"anthropic", "gemini", "kimi", "openai", "local"}
        assert set(BACKENDS) == expected

    def test_priority_lists_all_backends(self):
        assert set(_BACKEND_PRIORITY) == set(BACKENDS)
        assert _BACKEND_PRIORITY[-1] == "local", "local must be last to avoid shadowing paid keys"

    @pytest.mark.parametrize(
        "backend, expected_env_keys",
        [
            ("anthropic", ("ANTHROPIC_API_KEY",)),
            ("gemini", ("GEMINI_API_KEY", "GOOGLE_API_KEY")),
            ("kimi", ("MOONSHOT_API_KEY",)),
            ("openai", ("OPENAI_API_KEY",)),
            ("local", ()),
        ],
    )
    def test_env_keys_per_backend(self, backend, expected_env_keys):
        assert BACKENDS[backend].env_keys == expected_env_keys


class TestModelParity:
    """The same provider name must resolve to the same default model in
    both surfaces. The test reads the wiki default *via the wiki API*
    and compares to the registry default that generic ingest uses."""

    @pytest.mark.parametrize("backend", ["anthropic", "gemini", "openai", "kimi", "local"])
    def test_wiki_and_ingest_agree_on_default_model(self, backend, monkeypatch):
        # Make sure no OT_LLM_MODEL_* / OT_WIKI_MODEL env var is hijacking the lookup.
        cfg = BACKENDS[backend]
        if cfg.model_env_var:
            monkeypatch.delenv(cfg.model_env_var, raising=False)
        monkeypatch.delenv("OT_WIKI_MODEL", raising=False)
        from_registry = resolve_model(backend, None)
        # wiki.llm._default_model is the wiki-side wrapper used by
        # AnthropicLLM/GeminiLLM/etc.; both must agree.
        from opentrace_agent.wiki.llm import _default_model

        assert _default_model(backend) == from_registry == cfg.default_model

    def test_explicit_model_overrides(self, monkeypatch):
        assert resolve_model("anthropic", "claude-opus-9000") == "claude-opus-9000"

    def test_env_override_wins_over_default(self, monkeypatch):
        monkeypatch.setenv("OT_LLM_MODEL_ANTHROPIC", "from-env")
        assert resolve_model("anthropic", None) == "from-env"


class TestRoleModelResolution:
    """The ``role`` arg lets entity extraction run a cheap model while wiki
    synthesis keeps the flagship one, each with its own override env var."""

    @pytest.fixture(autouse=True)
    def _clear_env(self, monkeypatch):
        for var in ("OT_EXTRACTION_MODEL", "OT_WIKI_MODEL", "OT_WIKI_SUMMARY_MODEL", "OT_LLM_MODEL_ANTHROPIC"):
            monkeypatch.delenv(var, raising=False)

    def test_extraction_role_uses_cheap_tier(self):
        # Anthropic defines a cheaper extraction tier; wiki/default keep Sonnet.
        assert resolve_model("anthropic", None, role="extraction") == "claude-haiku-4-5"
        assert resolve_model("anthropic", None, role="wiki") == BACKENDS["anthropic"].default_model
        assert resolve_model("anthropic", None) == BACKENDS["anthropic"].default_model

    def test_wiki_summary_role_uses_cheap_tier_but_wiki_stays_flagship(self):
        # File summaries run cheap; plan/synthesis (role="wiki") stay flagship.
        assert resolve_model("anthropic", None, role="wiki_summary") == "claude-haiku-4-5"
        assert resolve_model("anthropic", None, role="wiki") == BACKENDS["anthropic"].default_model

    def test_wiki_summary_override_is_independent(self, monkeypatch):
        monkeypatch.setenv("OT_WIKI_SUMMARY_MODEL", "sum-x")
        assert resolve_model("anthropic", None, role="wiki_summary") == "sum-x"
        # Doesn't leak into the flagship wiki role or the default.
        assert resolve_model("anthropic", None, role="wiki") == BACKENDS["anthropic"].default_model
        assert resolve_model("anthropic", None) == BACKENDS["anthropic"].default_model

    def test_extraction_role_falls_back_when_no_cheap_tier(self):
        # Backends without a separate cheap tier (local, kimi) fall back to default.
        assert resolve_model("local", None, role="extraction") == BACKENDS["local"].default_model
        assert resolve_model("kimi", None, role="extraction") == BACKENDS["kimi"].default_model

    def test_gemini_and_openai_mirror_the_cheap_flagship_split(self):
        # Like Anthropic: cheap per-doc tier (extraction/wiki_summary) + smarter
        # flagship (wiki) for resolve + concept synthesis.
        assert resolve_model("gemini", None, role="wiki_summary") == BACKENDS["gemini"].extraction_model
        assert resolve_model("gemini", None, role="wiki") == BACKENDS["gemini"].default_model
        assert resolve_model("openai", None, role="extraction") == BACKENDS["openai"].extraction_model
        assert resolve_model("openai", None, role="wiki") == BACKENDS["openai"].default_model

    def test_role_env_overrides_are_independent(self, monkeypatch):
        monkeypatch.setenv("OT_EXTRACTION_MODEL", "ext-x")
        monkeypatch.setenv("OT_WIKI_MODEL", "wiki-y")
        assert resolve_model("anthropic", None, role="extraction") == "ext-x"
        assert resolve_model("anthropic", None, role="wiki") == "wiki-y"
        # role=None ignores both role-specific vars.
        assert resolve_model("anthropic", None) == BACKENDS["anthropic"].default_model

    def test_explicit_override_beats_role_env(self, monkeypatch):
        monkeypatch.setenv("OT_EXTRACTION_MODEL", "ext-x")
        assert resolve_model("anthropic", "explicit", role="extraction") == "explicit"

    def test_role_env_beats_generic_backend_env(self, monkeypatch):
        monkeypatch.setenv("OT_EXTRACTION_MODEL", "ext-x")
        monkeypatch.setenv("OT_LLM_MODEL_ANTHROPIC", "generic")
        assert resolve_model("anthropic", None, role="extraction") == "ext-x"
        # Without a role, the generic backend env still wins over the default.
        assert resolve_model("anthropic", None) == "generic"


class TestKeyResolutionParity:
    def test_anthropic_key_resolves(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant")
        assert resolve_api_key("anthropic") == "sk-ant"

    def test_gemini_falls_back_to_google_key(self, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.setenv("GOOGLE_API_KEY", "g-key")
        assert resolve_api_key("gemini") == "g-key"

    def test_missing_key_returns_empty(self, monkeypatch):
        for k in ("ANTHROPIC_API_KEY",):
            monkeypatch.delenv(k, raising=False)
        assert resolve_api_key("anthropic") == ""


class TestBaseUrlResolution:
    def test_kimi_uses_registry_default(self, monkeypatch):
        monkeypatch.delenv("OT_LOCAL_LLM_URL", raising=False)
        assert resolve_base_url("kimi") == "https://api.moonshot.ai/v1"

    def test_local_picks_up_ot_local_llm_url(self, monkeypatch):
        monkeypatch.setenv("OT_LOCAL_LLM_URL", "http://my-box:11434")
        assert resolve_base_url("local") == "http://my-box:11434"

    def test_local_falls_back_to_ollama_base_url(self, monkeypatch):
        monkeypatch.delenv("OT_LOCAL_LLM_URL", raising=False)
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://other:11434")
        assert resolve_base_url("local") == "http://other:11434"

    def test_explicit_override_wins(self, monkeypatch):
        monkeypatch.setenv("OT_LOCAL_LLM_URL", "http://env")
        assert resolve_base_url("local", "http://explicit") == "http://explicit"
