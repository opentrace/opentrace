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

"""LLM client wrappers + BYOK key resolver for the wiki pipeline.

Four providers are supported, mirroring the chat surface: Anthropic,
Google Gemini, OpenAI, and any OpenAI-compatible local endpoint
(Ollama, llama.cpp, vLLM, …). All four use forced tool-calling for
structured output, so callers see the same ``WikiLLM.call_tool`` shape
regardless of provider.

All wrappers retry transient upstream failures (429 rate-limit and 5xx
server errors) with exponential backoff before surfacing them to the
caller. Permanent failures (auth, schema) propagate immediately.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import threading
import time
from collections.abc import Callable
from typing import Any, Protocol, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Default retry policy. ``max_delay`` doubles as the give-up threshold: we
# honour a server's ``retry-after`` hint *fully* up to this many seconds (so a
# fixed-window provider like Gemini that asks for ~60 s is respected in one
# sleep instead of thrashing a 30 s cap), but a hint *longer* than this signals
# a daily/hourly quota that won't refill within any retry — so we give up
# rather than burn attempts on an inevitable failure.
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_BASE_DELAY = 1.0
DEFAULT_MAX_DELAY = 180.0


def _retry_call(
    fn: Callable[[], T],
    *,
    classify: Callable[[BaseException], float | None],
    on_throttle: Callable[[], None] | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    base_delay: float = DEFAULT_BASE_DELAY,
    max_delay: float = DEFAULT_MAX_DELAY,
    label: str = "llm",
) -> T:
    """Call *fn* with retries on transient errors.

    ``classify(e)`` returns either:

    - ``None`` — error is permanent, re-raise immediately.
    - a float ≥ 0 — seconds the server hinted to wait. We sleep at least
      that long; if 0, we fall back to exponential backoff. A hint greater
      than ``max_delay`` is treated as a long-window quota → give up.

    ``on_throttle`` (when given) is called once per retry, before sleeping —
    the shared adaptive limiter uses it to shed concurrency under throttling.
    The actual sleep is ``max(hint, backoff)`` (the server hint wins when it
    asks for more time than our backoff would allow), plus a small jitter.
    """
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — selectively re-raised below
            hint = classify(e)
            if hint is None or attempt == max_attempts:
                raise
            # Hint longer than we're willing to wait → long-window (daily/
            # hourly) quota that won't refill in a retry window. Give up.
            if hint > max_delay:
                raise
            if on_throttle is not None:
                on_throttle()
            backoff = base_delay * (2 ** (attempt - 1))
            delay = min(max_delay, max(hint, backoff))
            jitter = random.uniform(0, delay * 0.25)
            logger.warning(
                "%s transient failure (attempt %d/%d): %s — retrying in %.1fs%s",
                label,
                attempt,
                max_attempts,
                e,
                delay + jitter,
                f" (server hint: {hint:.1f}s)" if hint > 0 else "",
            )
            time.sleep(delay + jitter)
    raise RuntimeError("retry loop exited without returning or raising")


_GEMINI_RETRY_DELAY_RE = re.compile(
    r"['\"]?retryDelay['\"]?\s*:\s*['\"]?(\d+(?:\.\d+)?)s",
)
_GEMINI_LONG_QUOTA_RE = re.compile(
    r"PerDay|PerHour|PerProjectPerDay",
    re.IGNORECASE,
)


def _parse_gemini_retry_delay(e: BaseException) -> float:
    """Pull Gemini's ``retryDelay`` out of the error string, or 0 if absent.

    Gemini's ClientError carries a ``RetryInfo`` detail with ``retryDelay``
    formatted as ``"8s"``. The exact attribute layout differs between
    SDK versions, so we string-match the JSON-rendered repr — robust and
    cheap.
    """
    m = _GEMINI_RETRY_DELAY_RE.search(str(e))
    return float(m.group(1)) if m else 0.0


def _gemini_is_long_window_quota(e: BaseException) -> bool:
    """True for daily/hourly quotas that won't reset within a retry window.

    These show up as ``quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier``
    or similar. The server still suggests a short ``retryDelay`` (the next
    per-minute slot) but retrying immediately just burns attempts because
    the longer window hasn't refilled.
    """
    return bool(_GEMINI_LONG_QUOTA_RE.search(str(e)))


def _parse_retry_after_header(e: BaseException) -> float:
    """Pull ``Retry-After`` (seconds) out of an SDK status error.

    Both Anthropic and OpenAI surface their rate-limit response with a
    standard ``Retry-After`` header on ``response.headers``.
    """
    response = getattr(e, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return 0.0
    raw = headers.get("retry-after") or headers.get("Retry-After")
    if not raw:
        return 0.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


class AdaptiveLimiter:
    """A shrinkable concurrency gate shared across the wiki LLM loops.

    Starts at *initial* permits. On a throttle signal it **halves** the ceiling
    (floor 1), but at most once per *cooldown* window — so a burst of N
    simultaneous 429s counts as one reduction, not N. It only ratchets **down**
    and never recovers within a run: once a tier's safe level is found, it stays
    there. Combined with the retry layer honouring ``retry-after``, this lets a
    high default (8) run fast on a healthy tier yet self-throttle on a low one
    instead of racing calls into retry-exhaustion.

    Note: reducing concurrency only helps *token-rate* / *concurrency* limits
    (Anthropic OTPM, Kimi concurrency, OpenAI TPM). For pure request-per-minute
    limits (Gemini RPM) it can't lower throughput — there the retry layer's
    ``retry-after`` pacing carries the run, and this just settles low (harmless).
    """

    def __init__(self, initial: int, *, cooldown: float = 5.0):
        self._limit = max(1, initial)
        self._in_flight = 0
        self._cooldown = cooldown
        self._last_ratchet = 0.0
        self._cond = threading.Condition()

    def acquire(self) -> None:
        with self._cond:
            while self._in_flight >= self._limit:
                self._cond.wait()
            self._in_flight += 1

    def release(self) -> None:
        with self._cond:
            self._in_flight -= 1
            self._cond.notify()

    def signal_throttle(self) -> None:
        """Ratchet the ceiling down one notch (halve), cooldown-collapsed."""
        with self._cond:
            now = time.monotonic()
            if self._limit <= 1 or (now - self._last_ratchet) < self._cooldown:
                return
            self._limit = max(1, self._limit // 2)
            self._last_ratchet = now
            logger.warning("wiki: throttled by provider — reducing concurrency to %d", self._limit)

    @property
    def limit(self) -> int:
        with self._cond:
            return self._limit


def _gated_retry(
    limiter: AdaptiveLimiter | None,
    fn: Callable[[], T],
    *,
    classify: Callable[[BaseException], float | None],
    label: str,
) -> T:
    """Run ``_retry_call`` under the shared limiter (acquire → call → release),
    wiring the limiter's ratchet as the throttle hook. No-op gating when the
    client has no limiter attached (e.g. test fakes)."""
    if limiter is None:
        return _retry_call(fn, classify=classify, label=label)
    limiter.acquire()
    try:
        return _retry_call(fn, classify=classify, on_throttle=limiter.signal_throttle, label=label)
    finally:
        limiter.release()


from opentrace_agent.sources._llm_common import (
    BACKENDS,
    canonical_backend,
    resolve_api_key,
    resolve_base_url,
    resolve_model,
)

PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_GEMINI = "gemini"
PROVIDER_OPENAI = "openai"
PROVIDER_KIMI = "kimi"
PROVIDER_LOCAL = "local"
SUPPORTED_PROVIDERS = (
    PROVIDER_ANTHROPIC,
    PROVIDER_GEMINI,
    PROVIDER_OPENAI,
    PROVIDER_KIMI,
    PROVIDER_LOCAL,
)


class WikiLLMError(RuntimeError):
    pass


class WikiLLM(Protocol):
    """Protocol the pipeline depends on. Tests substitute a fake implementation."""

    def call_tool(
        self,
        *,
        system: str,
        user: str,
        tool_name: str,
        tool_schema: dict[str, Any],
        max_tokens: int = 4096,
    ) -> dict[str, Any]: ...


_BACKEND_LABELS = {
    "anthropic": "Anthropic",
    "gemini": "Gemini",
    "openai": "OpenAI",
    "kimi": "Kimi",
    "local": "Local",
}


def _resolve_key(explicit: str | None, backend: str) -> str:
    """Resolve an API key for *backend* — explicit override or env var.

    *backend* is a canonical name (``anthropic``/``gemini``/...). Reads the
    shared BACKENDS registry so the env-var conventions stay in lockstep
    with the generic-ingest path.
    """
    if explicit:
        return explicit
    canonical = canonical_backend(backend)
    key = resolve_api_key(canonical)
    if not key:
        cfg = BACKENDS[canonical]
        label = _BACKEND_LABELS.get(canonical, canonical)
        envs = " or ".join(f"${k}" for k in cfg.env_keys) if cfg.env_keys else "(no key required)"
        raise WikiLLMError(f"{label} API key missing — pass api_key= or set {envs}.")
    return key


def _default_model(backend: str) -> str:
    """Resolve the default model for *backend* via the shared registry.

    Uses the ``wiki`` role so synthesis keeps the flagship model (and honours
    ``OT_WIKI_MODEL``) rather than dropping to the cheap extraction tier.
    """
    return resolve_model(backend, None, role="wiki")


class AnthropicLLM:
    """Thin Anthropic wrapper that forces tool-use for structured output."""

    def __init__(self, api_key: str | None = None, *, model: str | None = None):
        try:
            import anthropic
        except ImportError as e:
            raise WikiLLMError("the 'anthropic' package is required — install with: uv add anthropic") from e
        self._client = anthropic.Anthropic(api_key=_resolve_key(api_key, "anthropic"))
        self._model = model or _default_model("anthropic")
        self._max_out = BACKENDS["anthropic"].max_output_tokens

    def call_tool(
        self,
        *,
        system: str,
        user: str,
        tool_name: str,
        tool_schema: dict[str, Any],
        max_tokens: int = 4096,
    ) -> dict[str, Any]:
        import anthropic

        max_tokens = min(max_tokens, self._max_out)

        def _classify(e: BaseException) -> float | None:
            if isinstance(e, anthropic.APIConnectionError):
                return 0.0
            if isinstance(e, anthropic.RateLimitError):
                return _parse_retry_after_header(e)
            if isinstance(e, anthropic.InternalServerError):
                return 0.0
            if isinstance(e, anthropic.APIStatusError):
                if e.status_code >= 500 or e.status_code == 429:
                    return _parse_retry_after_header(e)
            return None

        def _do() -> Any:
            # Stream rather than create(): the SDK refuses a non-streaming
            # request whose max_tokens could imply a >10-minute response
            # (max_tokens > ~21k, or > the model's non-streaming cap — e.g.
            # Opus's 8k). Our synthesis calls request 32k, so we stream and
            # reassemble the final message. Keeps the per-backend clamp's
            # promise that any max_tokens up to the cap is usable.
            with self._client.messages.stream(
                model=self._model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
                tools=[
                    {
                        "name": tool_name,
                        "description": tool_schema.get("description", ""),
                        "input_schema": tool_schema["input_schema"],
                    }
                ],
                tool_choice={"type": "tool", "name": tool_name},
            ) as stream:
                return stream.get_final_message()

        response = _gated_retry(getattr(self, "_limiter", None), _do, classify=_classify, label="anthropic")
        for block in response.content:
            if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
                return dict(block.input)
        raise WikiLLMError(f"LLM did not return a tool_use block for {tool_name!r}")


class GeminiLLM:
    """Thin Gemini wrapper that forces a single function call for structured output.

    Uses the newer ``google-genai`` SDK. Gemini's function-calling schema is a
    subset of OpenAPI/JSON-Schema — for our two simple object schemas (Plan,
    EmitPage) it lines up directly with what we already pass to Anthropic.
    """

    def __init__(self, api_key: str | None = None, *, model: str | None = None):
        try:
            from google import genai
        except ImportError as e:
            raise WikiLLMError("the 'google-genai' package is required — install with: uv add google-genai") from e
        self._client = genai.Client(api_key=_resolve_key(api_key, "gemini"))
        self._model = model or _default_model("gemini")
        self._max_out = BACKENDS["gemini"].max_output_tokens

    def call_tool(
        self,
        *,
        system: str,
        user: str,
        tool_name: str,
        tool_schema: dict[str, Any],
        max_tokens: int = 4096,
    ) -> dict[str, Any]:
        from google.genai import errors, types

        max_tokens = min(max_tokens, self._max_out)
        function_decl = types.FunctionDeclaration(
            name=tool_name,
            description=tool_schema.get("description", ""),
            parameters=tool_schema["input_schema"],
        )
        config = types.GenerateContentConfig(
            system_instruction=system,
            tools=[types.Tool(function_declarations=[function_decl])],
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode="ANY",
                    allowed_function_names=[tool_name],
                )
            ),
            max_output_tokens=max_tokens,
        )

        def _classify(e: BaseException) -> float | None:
            # Server errors (5xx) — overload, internal, etc. Use backoff.
            if isinstance(e, errors.ServerError):
                return 0.0
            # 429s come back as ClientError with code=429. The body carries
            # a RetryInfo with the recommended wait — honour it when present.
            if isinstance(e, errors.ClientError):
                code = getattr(e, "code", None) or getattr(e, "status_code", None)
                if code != 429:
                    return None
                # Daily/hourly quotas don't refill within any reasonable
                # retry window. Surface immediately so the user can switch
                # provider rather than burn attempts on inevitable failures.
                if _gemini_is_long_window_quota(e):
                    return None
                return _parse_gemini_retry_delay(e)
            return None

        def _do() -> Any:
            return self._client.models.generate_content(
                model=self._model,
                contents=user,
                config=config,
            )

        response = _gated_retry(getattr(self, "_limiter", None), _do, classify=_classify, label="gemini")
        for candidate in response.candidates or []:
            content = getattr(candidate, "content", None)
            if content is None:
                continue
            for part in getattr(content, "parts", None) or []:
                fc = getattr(part, "function_call", None)
                if fc and fc.name == tool_name:
                    args = fc.args
                    if args is None:
                        return {}
                    # `args` is a Mapping[str, Any] (proto MapComposite); coerce
                    # to a plain dict so the rest of the pipeline can iterate.
                    return dict(args)
        raise WikiLLMError(f"Gemini did not return a function_call for {tool_name!r}")


class _OpenAICompatibleLLM:
    """Shared implementation for OpenAI and OpenAI-compatible local endpoints.

    Tool-calling shape is identical (``tools=[{type: function, ...}]`` plus a
    forced ``tool_choice``); the only differences across the two are which
    env var holds the key and whether ``base_url`` points to a local
    server. Subclasses pick those.
    """

    def __init__(self, *, api_key: str, base_url: str | None, model: str, label: str):
        try:
            import openai
        except ImportError as e:
            raise WikiLLMError("the 'openai' package is required — install with: uv add openai") from e
        kwargs: dict[str, Any] = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        self._client = openai.OpenAI(**kwargs)
        self._model = model
        self._label = label
        cfg = BACKENDS.get(label)
        self._max_out = cfg.max_output_tokens if cfg else 8192

    def call_tool(
        self,
        *,
        system: str,
        user: str,
        tool_name: str,
        tool_schema: dict[str, Any],
        max_tokens: int = 4096,
    ) -> dict[str, Any]:
        import openai

        max_tokens = min(max_tokens, self._max_out)

        def _classify(e: BaseException) -> float | None:
            if isinstance(e, openai.APIConnectionError):
                return 0.0
            if isinstance(e, openai.RateLimitError):
                return _parse_retry_after_header(e)
            if isinstance(e, openai.InternalServerError):
                return 0.0
            if isinstance(e, openai.APIStatusError):
                if e.status_code >= 500 or e.status_code == 429:
                    return _parse_retry_after_header(e)
            return None

        def _do() -> Any:
            return self._client.chat.completions.create(
                model=self._model,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                tools=[
                    {
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "description": tool_schema.get("description", ""),
                            "parameters": tool_schema["input_schema"],
                        },
                    }
                ],
                tool_choice={"type": "function", "function": {"name": tool_name}},
            )

        response = _gated_retry(getattr(self, "_limiter", None), _do, classify=_classify, label=self._label)
        choices = getattr(response, "choices", None) or []
        for choice in choices:
            tool_calls = getattr(choice.message, "tool_calls", None) or []
            for tc in tool_calls:
                if tc.function.name != tool_name:
                    continue
                try:
                    return json.loads(tc.function.arguments)
                except json.JSONDecodeError as e:
                    raise WikiLLMError(f"{self._label} returned malformed tool arguments for {tool_name!r}: {e}") from e
        raise WikiLLMError(f"{self._label} did not return a tool_call for {tool_name!r}")


class OpenAILLM(_OpenAICompatibleLLM):
    """Thin OpenAI wrapper that forces a single tool call for structured output."""

    def __init__(self, api_key: str | None = None, *, model: str | None = None):
        super().__init__(
            api_key=_resolve_key(api_key, "openai"),
            base_url=None,
            model=model or _default_model("openai"),
            label="openai",
        )


class KimiLLM(_OpenAICompatibleLLM):
    """Moonshot Kimi via its OpenAI-compatible endpoint."""

    def __init__(self, api_key: str | None = None, *, model: str | None = None):
        super().__init__(
            api_key=_resolve_key(api_key, "kimi"),
            base_url=resolve_base_url("kimi"),
            model=model or _default_model("kimi"),
            label="kimi",
        )


class LocalLLM(_OpenAICompatibleLLM):
    """OpenAI-compatible local endpoint (Ollama, llama.cpp, vLLM, …).

    Local servers typically don't validate ``api_key`` — we default to the
    literal string ``"local"`` when none is provided. ``base_url`` should be
    the bare server URL (e.g. ``http://localhost:11434``); we append ``/v1``
    if it isn't already present so the OpenAI client hits the right path.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        model: str | None = None,
        base_url: str | None = None,
    ):
        # Local explicitly requires a URL — either passed in or via env. We
        # deliberately don't fall back to the registry's localhost default
        # because wiki compile against a random localhost service is rarely
        # what the user means by ``--provider local`` (vs. the generic
        # ingest path which is happier to assume Ollama).
        url = base_url or os.environ.get("OT_LOCAL_LLM_URL") or os.environ.get("OLLAMA_BASE_URL")
        if not url:
            raise WikiLLMError(
                "Local LLM base URL missing — pass base_url= or set $OT_LOCAL_LLM_URL (e.g. http://localhost:11434)."
            )
        url = url.rstrip("/")
        if not url.endswith("/v1"):
            url = url + "/v1"
        super().__init__(
            api_key=api_key or "local",
            base_url=url,
            model=model or _default_model("local"),
            label="local",
        )


def make_llm(
    provider: str,
    *,
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
) -> WikiLLM:
    """Construct a :class:`WikiLLM` for the requested provider.

    Provider must be one of :data:`SUPPORTED_PROVIDERS` (legacy aliases
    ``claude`` / ``ollama`` are accepted and translated to ``anthropic`` /
    ``local`` respectively). ``model`` overrides the per-provider default
    (looked up from the shared BACKENDS registry). ``base_url`` is only
    meaningful for the ``"local"`` provider.
    """
    canonical = canonical_backend(provider)
    if canonical == PROVIDER_ANTHROPIC:
        return AnthropicLLM(api_key=api_key, model=model)
    if canonical == PROVIDER_GEMINI:
        return GeminiLLM(api_key=api_key, model=model)
    if canonical == PROVIDER_OPENAI:
        return OpenAILLM(api_key=api_key, model=model)
    if canonical == PROVIDER_KIMI:
        return KimiLLM(api_key=api_key, model=model)
    if canonical == PROVIDER_LOCAL:
        return LocalLLM(api_key=api_key, model=model, base_url=base_url)
    raise WikiLLMError(f"unsupported provider {provider!r} — choose one of {SUPPORTED_PROVIDERS}")
