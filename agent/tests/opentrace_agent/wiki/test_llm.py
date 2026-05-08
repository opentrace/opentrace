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

import pytest

from opentrace_agent.wiki.llm import (
    AnthropicLLM,
    GeminiLLM,
    LocalLLM,
    OpenAILLM,
    WikiLLMError,
    make_llm,
)


def test_make_llm_anthropic_routes_to_anthropic_class(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    llm = make_llm("anthropic")
    assert isinstance(llm, AnthropicLLM)


def test_make_llm_gemini_routes_to_gemini_class(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "g-test")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    llm = make_llm("gemini")
    assert isinstance(llm, GeminiLLM)


def test_make_llm_openai_routes_to_openai_class(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-test")
    llm = make_llm("openai")
    assert isinstance(llm, OpenAILLM)


def test_make_llm_local_routes_to_local_class(monkeypatch):
    monkeypatch.delenv("OT_LOCAL_LLM_URL", raising=False)
    llm = make_llm("local", base_url="http://localhost:11434")
    assert isinstance(llm, LocalLLM)


def test_make_llm_unknown_provider_raises():
    with pytest.raises(WikiLLMError):
        make_llm("cohere")


def test_anthropic_llm_missing_key_raises(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(WikiLLMError, match="Anthropic"):
        AnthropicLLM(api_key=None)


def test_gemini_llm_missing_key_raises(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    with pytest.raises(WikiLLMError, match="Gemini"):
        GeminiLLM(api_key=None)


def test_gemini_llm_falls_back_to_google_api_key_env(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "g-fallback")
    # Constructing the client is enough — the SDK accepts any string up front.
    llm = GeminiLLM(api_key=None)
    assert llm is not None


def test_openai_llm_missing_key_raises(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(WikiLLMError, match="OpenAI"):
        OpenAILLM(api_key=None)


def test_local_llm_missing_base_url_raises(monkeypatch):
    monkeypatch.delenv("OT_LOCAL_LLM_URL", raising=False)
    with pytest.raises(WikiLLMError, match="Local LLM base URL missing"):
        LocalLLM(api_key=None, base_url=None)


def test_local_llm_appends_v1_when_missing():
    """The OpenAI client expects ``/v1`` on the base URL — append if absent."""
    llm = LocalLLM(api_key=None, base_url="http://localhost:11434")
    # The openai client stores the resolved base URL; we just check the
    # outward-facing wrapper landed on a URL ending in /v1.
    assert str(llm._client.base_url).rstrip("/").endswith("/v1")


def test_local_llm_keeps_v1_when_present():
    llm = LocalLLM(api_key=None, base_url="http://localhost:11434/v1")
    assert str(llm._client.base_url).rstrip("/").endswith("/v1")
    # And we don't double it up.
    assert "/v1/v1" not in str(llm._client.base_url)


def test_local_llm_reads_url_from_env(monkeypatch):
    monkeypatch.setenv("OT_LOCAL_LLM_URL", "http://example.local:8000")
    llm = LocalLLM(api_key=None)
    assert "example.local:8000" in str(llm._client.base_url)


def test_retry_call_retries_transient_then_succeeds(monkeypatch):
    """Transient errors are retried; the call eventually succeeds."""
    from opentrace_agent.wiki.llm import _retry_call

    monkeypatch.setattr("opentrace_agent.wiki.llm.time.sleep", lambda _s: None)

    calls = {"n": 0}

    class TransientErr(RuntimeError):
        pass

    def fn():
        calls["n"] += 1
        if calls["n"] < 3:
            raise TransientErr("boom")
        return "ok"

    result = _retry_call(fn, classify=lambda e: 0.0 if isinstance(e, TransientErr) else None)
    assert result == "ok"
    assert calls["n"] == 3


def test_retry_call_does_not_retry_permanent_errors(monkeypatch):
    from opentrace_agent.wiki.llm import _retry_call

    monkeypatch.setattr("opentrace_agent.wiki.llm.time.sleep", lambda _s: None)

    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise ValueError("auth")

    with pytest.raises(ValueError):
        _retry_call(fn, classify=lambda e: None)
    assert calls["n"] == 1


def test_retry_call_gives_up_after_max_attempts(monkeypatch):
    from opentrace_agent.wiki.llm import _retry_call

    monkeypatch.setattr("opentrace_agent.wiki.llm.time.sleep", lambda _s: None)

    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise RuntimeError("down")

    with pytest.raises(RuntimeError):
        _retry_call(fn, classify=lambda e: 0.0, max_attempts=4)
    assert calls["n"] == 4


def test_retry_call_uses_server_hint_when_longer_than_backoff(monkeypatch):
    """A server-supplied delay overrides the exponential backoff."""
    from opentrace_agent.wiki import llm

    sleeps: list[float] = []
    monkeypatch.setattr(llm.time, "sleep", lambda s: sleeps.append(s))
    # Disable jitter so we can compare exactly.
    monkeypatch.setattr(llm.random, "uniform", lambda _a, _b: 0.0)

    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("rate limited")
        return "ok"

    # First retry: hint=10s wins over backoff 1s. Second retry: hint=0
    # falls back to backoff 2s.
    hints = iter([10.0, 0.0])

    def classify(e):
        return next(hints)

    result = llm._retry_call(fn, classify=classify, base_delay=1.0, max_delay=60.0)
    assert result == "ok"
    assert sleeps == [10.0, 2.0]


def test_parse_gemini_retry_delay_extracts_seconds():
    from opentrace_agent.wiki.llm import _parse_gemini_retry_delay

    msg = (
        "ClientError: 429 RESOURCE_EXHAUSTED. {'error': {'details': [{'@type': '...RetryInfo', 'retryDelay': '8.5s'}]}}"
    )

    class E(Exception):
        def __str__(self):
            return msg

    assert _parse_gemini_retry_delay(E()) == 8.5


def test_parse_gemini_retry_delay_returns_zero_when_absent():
    from opentrace_agent.wiki.llm import _parse_gemini_retry_delay

    assert _parse_gemini_retry_delay(RuntimeError("nope")) == 0.0
