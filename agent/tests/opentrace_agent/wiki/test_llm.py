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
    AdaptiveLimiter,
    AnthropicLLM,
    GeminiLLM,
    LocalLLM,
    OpenAILLM,
    WikiLLMError,
    _retry_call,
    make_llm,
)


class TestAdaptiveLimiter:
    def test_halves_on_throttle_and_floors_at_one(self):
        lim = AdaptiveLimiter(8, cooldown=0)  # cooldown=0 → every signal counts
        assert lim.limit == 8
        lim.signal_throttle()
        assert lim.limit == 4
        lim.signal_throttle()
        assert lim.limit == 2
        lim.signal_throttle()
        assert lim.limit == 1
        lim.signal_throttle()  # floors — never below 1
        assert lim.limit == 1

    def test_cooldown_collapses_a_burst_to_one_reduction(self):
        lim = AdaptiveLimiter(8, cooldown=1000)  # long cooldown
        lim.signal_throttle()
        lim.signal_throttle()
        lim.signal_throttle()
        assert lim.limit == 4  # a simultaneous burst = a single reduction

    def test_first_ratchet_fires_on_a_freshly_booted_machine(self, monkeypatch):
        """The cooldown must not suppress the run's FIRST reduction.

        ``time.monotonic()`` counts from boot on Linux, so on a machine with
        less uptime than the cooldown a 0.0 "last ratchet" sentinel looks like a
        ratchet that just happened — every 429 was ignored and concurrency
        stayed at the default for the whole run. This passed on any long-lived
        dev box and failed only on fresh CI runners and containers.
        """
        monkeypatch.setattr("opentrace_agent.wiki.llm.time.monotonic", lambda: 42.0)
        lim = AdaptiveLimiter(8, cooldown=1000)
        lim.signal_throttle()
        assert lim.limit == 4

    def test_acquire_release_accounting(self):
        lim = AdaptiveLimiter(2, cooldown=0)
        lim.acquire()
        lim.acquire()  # at limit (2), both return without blocking
        assert lim._in_flight == 2
        lim.release()
        assert lim._in_flight == 1

    def test_down_only_never_increases(self):
        lim = AdaptiveLimiter(4, cooldown=0)
        lim.signal_throttle()
        assert lim.limit == 2
        lim.acquire()
        lim.release()
        assert lim.limit == 2  # acquire/release must not bump the ceiling back up


class TestOutputTokenCap:
    def test_clients_carry_their_backend_output_cap(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        assert AnthropicLLM()._max_out == 64000
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        assert OpenAILLM()._max_out == 32768  # gpt-4.1 ceiling — guards a 32k+ request

    def test_all_backends_define_a_sane_output_cap(self):
        from opentrace_agent.sources._llm_common import BACKENDS

        for name, cfg in BACKENDS.items():
            assert cfg.max_output_tokens >= 4096, name


class TestAnthropicStreaming:
    """The Anthropic tool call must STREAM, not create(): a non-streaming request
    with max_tokens > ~21k raises a ValueError in the SDK. Streaming removes that
    ceiling so the per-backend clamp (up to 64k) is actually usable."""

    def _fake_client(self, msg):
        import types

        class _Stream:
            def __enter__(self_):
                return self_

            def __exit__(self_, *a):
                return False

            def get_final_message(self_):
                return msg

        class _Messages:
            def stream(self_, **kw):
                self_.stream_kwargs = kw
                return _Stream()

            def create(self_, **kw):  # must NOT be used
                raise AssertionError("Anthropic tool call used create() — must stream")

        messages = _Messages()
        return types.SimpleNamespace(messages=messages), messages

    def test_streams_and_parses_tool_use_for_large_max_tokens(self, monkeypatch):
        import types

        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        block = types.SimpleNamespace(type="tool_use", name="emit_page", input={"markdown_body": "ok"})
        msg = types.SimpleNamespace(content=[block])

        llm = AnthropicLLM()
        client, messages = self._fake_client(msg)
        llm._client = client

        out = llm.call_tool(
            system="s",
            user="u",
            tool_name="emit_page",
            tool_schema={"description": "d", "input_schema": {"type": "object", "properties": {}}},
            max_tokens=32_000,  # would trip the non-streaming guard
        )
        assert out == {"markdown_body": "ok"}
        assert messages.stream_kwargs["max_tokens"] == 32_000


class TestRetryGiveUp:
    def test_gives_up_when_hint_exceeds_max_delay(self):
        # A multi-hour hint (daily quota) → give up immediately, don't thrash.
        attempts = {"n": 0}

        def fn():
            attempts["n"] += 1
            raise RuntimeError("429 daily quota")

        with pytest.raises(RuntimeError):
            _retry_call(fn, classify=lambda e: 86_400.0, max_delay=180.0, label="t")
        assert attempts["n"] == 1  # no retries — hint was too long

    def test_calls_on_throttle_before_retrying(self):
        calls = {"throttle": 0, "fn": 0}

        def fn():
            calls["fn"] += 1
            if calls["fn"] < 2:
                raise RuntimeError("429")
            return "ok"

        out = _retry_call(
            fn,
            classify=lambda e: 0.0,  # retryable, no hint → backoff
            on_throttle=lambda: calls.__setitem__("throttle", calls["throttle"] + 1),
            base_delay=0.0,  # no real sleep
            label="t",
        )
        assert out == "ok"
        assert calls["throttle"] == 1


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
