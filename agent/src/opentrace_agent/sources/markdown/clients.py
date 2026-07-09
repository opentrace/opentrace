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

"""Multi-backend LLM clients implementing :class:`LLMClient`.

Five backends supported via env-var detection:

* **claude** — direct Anthropic SDK (``ANTHROPIC_API_KEY``).
* **openai** — OpenAI Chat Completions (``OPENAI_API_KEY``).
* **gemini** — Google Gemini via the OpenAI-compatible endpoint
  (``GEMINI_API_KEY`` or ``GOOGLE_API_KEY``).
* **kimi** — Moonshot Kimi via the OpenAI-compatible endpoint
  (``MOONSHOT_API_KEY``).
* **ollama** — local model via the Ollama OpenAI-compatible endpoint
  (``OLLAMA_BASE_URL``; no API key required).

Backend selection priority is **paid backends first, ollama last**, so a
stray ``OLLAMA_BASE_URL`` in someone's shell can't silently shadow a paid
key. Set the env var for the backend you want; the rest happens automatically.

The :class:`LLMClient` protocol is just ``complete(system, user) -> str``;
client classes also expose ``last_usage`` after each call so callers can
report token spend without needing to parse provider-specific response
shapes.
"""

from __future__ import annotations

from opentrace_agent.sources._llm_common import (
    BACKENDS,
    BackendConfig,
    _cost_usd,
    actionable_no_backend_message,
    canonical_backend,
    detect_backend,
    estimate_cost,
    resolve_api_key,
    resolve_base_url,
    resolve_model,
    resolve_timeout,
)

# Re-exported names so existing imports from this module keep working
# (and so ``from opentrace_agent.sources.markdown import …`` continues
# to surface the same surface area).
__all__ = [
    "BACKENDS",
    "BackendConfig",
    "actionable_no_backend_message",
    "detect_backend",
    "estimate_cost",
]


# ---------------------------------------------------------------------------
# Client implementations
# ---------------------------------------------------------------------------


class _BaseClient:
    """Shared book-keeping: last token usage, cost estimate."""

    def __init__(self, backend: str, model: str) -> None:
        self.backend = backend
        self.model = model
        self.last_usage: dict[str, int] = {"input_tokens": 0, "output_tokens": 0}

    def last_cost_usd(self) -> float:
        cfg = BACKENDS[self.backend]
        return _cost_usd(cfg, self.last_usage["input_tokens"], self.last_usage["output_tokens"])


class AnthropicClient(_BaseClient):
    """Uses the official ``anthropic`` SDK against the Anthropic API.

    The Anthropic SDK has a slightly different shape than OpenAI's — system
    prompt is a top-level field, response content is a list of blocks — so
    it gets its own class rather than going through the OpenAI-compat path.
    """

    def __init__(self, model: str, api_key: str) -> None:
        super().__init__("anthropic", model)
        try:
            from anthropic import Anthropic
        except ImportError as exc:
            raise RuntimeError("anthropic SDK not installed. Run: uv pip install 'opentraceai[graph]'") from exc
        # max_retries=0: the extraction stage owns the retry loop so it can
        # react to 429s (back off AND throttle concurrency). Letting the SDK
        # silently retry would hide rate limiting from that adaptive logic.
        self._client = Anthropic(api_key=api_key, max_retries=0)

    def complete(self, system: str, user: str) -> str:
        resp = self._client.messages.create(
            model=self.model,
            system=system,
            messages=[{"role": "user", "content": user}],
            max_tokens=16384,
            temperature=0,
        )
        if resp.usage is not None:
            self.last_usage = {
                "input_tokens": resp.usage.input_tokens,
                "output_tokens": resp.usage.output_tokens,
            }
        # Concatenate all text blocks; non-text blocks (none expected here)
        # are skipped rather than crashing on attribute access.
        chunks: list[str] = []
        for block in resp.content:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                chunks.append(text)
        return "".join(chunks)


class OpenAICompatClient(_BaseClient):
    """Routes any OpenAI-compatible API (OpenAI, Gemini, Kimi, Ollama) via the openai SDK.

    Different providers tweak the request shape (Kimi disables thinking,
    Gemini wants ``reasoning_effort``, Ollama wants ``num_ctx``); for v1 we
    keep the request flat and trust each provider's defaults. The cost is
    that local Ollama on big prompts may need a larger ``num_ctx`` —
    but that's solvable later without changing the call surface.
    """

    def __init__(self, backend: str, model: str, api_key: str, base_url: str) -> None:
        super().__init__(backend, model)
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError("openai SDK not installed. Run: uv pip install 'opentraceai[graph]'") from exc
        # Generous default timeout: local backends (Ollama, LM Studio,
        # llama.cpp) can take >60s on a single chunk against a large model.
        # Honour OT_LLM_TIMEOUT (seconds) for explicit override.
        timeout = resolve_timeout(default=600.0)
        # max_retries=0 for the same reason as AnthropicClient: the extraction
        # stage owns retry + adaptive concurrency, so SDK-level retries would
        # mask the 429s it needs to see.
        self._client = OpenAI(api_key=api_key or "no-key", base_url=base_url, timeout=timeout, max_retries=0)

    def complete(self, system: str, user: str) -> str:
        resp = self._client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens=16384,
            temperature=0,
        )
        if resp.usage is not None:
            self.last_usage = {
                "input_tokens": resp.usage.prompt_tokens,
                "output_tokens": resp.usage.completion_tokens,
            }
        choice = resp.choices[0]
        return choice.message.content or ""


# ---------------------------------------------------------------------------
# Detection + construction
# ---------------------------------------------------------------------------


def create_client(backend: str, *, model: str | None = None, role: str | None = None) -> _BaseClient:
    """Construct an :class:`LLMClient` for *backend*. Raises on unknown backends.

    Accepts canonical names (``anthropic``, ``local``, …) and the deprecated
    aliases (``claude``, ``ollama``). ``role`` selects role-specific model
    defaults/overrides (e.g. ``"extraction"`` → cheap tier).
    """
    canonical = canonical_backend(backend)
    if canonical not in BACKENDS:
        raise ValueError(f"unknown backend: {backend!r}. Known: {', '.join(sorted(BACKENDS))}")
    resolved_model = resolve_model(canonical, model, role=role)
    if canonical == "anthropic":
        return AnthropicClient(model=resolved_model, api_key=resolve_api_key(canonical))
    if canonical == "local":
        # Local doesn't require an API key — use the configured base_url
        # (or the one from env) and a placeholder key the SDK won't reject.
        return OpenAICompatClient(
            backend=canonical,
            model=resolved_model,
            api_key="local",
            base_url=resolve_base_url(canonical),
        )
    # openai / gemini / kimi all go through the OpenAI-compat client.
    return OpenAICompatClient(
        backend=canonical,
        model=resolved_model,
        api_key=resolve_api_key(canonical),
        base_url=resolve_base_url(canonical),
    )


def detect_client(*, model: str | None = None, role: str | None = None) -> tuple[_BaseClient, str] | None:
    """Return ``(client, backend_name)`` for the detected backend, or ``None``.

    Returns ``None`` when no env var is set — callers should treat that as a
    hard error if their feature depends on the LLM, or as a fallback signal
    if degraded mode is acceptable. ``role`` is forwarded to
    :func:`create_client` for role-specific model selection.
    """
    backend = detect_backend()
    if backend is None:
        return None
    return create_client(backend, model=model, role=role), backend


# Type alias for callers that don't care which concrete client they got.
LLMClient = _BaseClient
