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

Two providers are supported in v1: Anthropic and Google Gemini. Both use
forced tool-calling for structured output, so callers see the same
``WikiLLM.call_tool`` shape regardless of provider.

Both wrappers retry transient upstream failures (429 rate-limit and 5xx
server errors) with exponential backoff before surfacing them to the
caller. Permanent failures (auth, schema) propagate immediately.
"""

from __future__ import annotations

import logging
import os
import random
import re
import time
from collections.abc import Callable
from typing import Any, Protocol, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Default retry policy. Tuned to survive a per-minute rate-limit cycle on
# free-tier APIs: 5 attempts with up to 30 s of sleep per gap covers
# Gemini 5/min and similar windows.
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_BASE_DELAY = 1.0
DEFAULT_MAX_DELAY = 30.0


def _retry_call(
    fn: Callable[[], T],
    *,
    classify: Callable[[BaseException], float | None],
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    base_delay: float = DEFAULT_BASE_DELAY,
    max_delay: float = DEFAULT_MAX_DELAY,
    label: str = "llm",
) -> T:
    """Call *fn* with retries on transient errors.

    ``classify(e)`` returns either:

    - ``None`` — error is permanent, re-raise immediately.
    - a float ≥ 0 — seconds the server hinted to wait. We sleep at least
      that long; if 0, we fall back to exponential backoff.

    The actual sleep is ``max(hint, backoff)`` capped at ``max_delay``,
    plus a small jitter — so a server hint always wins if it asks for
    more time than our backoff would allow.
    """
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — selectively re-raised below
            hint = classify(e)
            if hint is None or attempt == max_attempts:
                raise
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


def _parse_anthropic_retry_after(e: BaseException) -> float:
    """Pull ``Retry-After`` (seconds) out of an Anthropic APIStatusError."""
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


PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_GEMINI = "gemini"
SUPPORTED_PROVIDERS = (PROVIDER_ANTHROPIC, PROVIDER_GEMINI)


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


def _resolve_key(explicit: str | None, env_var: str, label: str) -> str:
    key = explicit or os.environ.get(env_var)
    if not key:
        raise WikiLLMError(f"{label} API key missing — pass api_key= or set ${env_var}.")
    return key


_DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514"
_DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"


class AnthropicLLM:
    """Thin Anthropic wrapper that forces tool-use for structured output."""

    def __init__(self, api_key: str | None = None, *, model: str = _DEFAULT_ANTHROPIC_MODEL):
        try:
            import anthropic
        except ImportError as e:
            raise WikiLLMError("the 'anthropic' package is required — install with: uv add anthropic") from e
        self._client = anthropic.Anthropic(api_key=_resolve_key(api_key, "ANTHROPIC_API_KEY", "Anthropic"))
        self._model = model

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

        def _classify(e: BaseException) -> float | None:
            if isinstance(e, anthropic.APIConnectionError):
                return 0.0
            if isinstance(e, anthropic.RateLimitError):
                return _parse_anthropic_retry_after(e)
            if isinstance(e, anthropic.InternalServerError):
                return 0.0
            if isinstance(e, anthropic.APIStatusError):
                if e.status_code >= 500 or e.status_code == 429:
                    return _parse_anthropic_retry_after(e)
            return None

        def _do() -> Any:
            return self._client.messages.create(
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
            )

        response = _retry_call(_do, classify=_classify, label="anthropic")
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

    def __init__(self, api_key: str | None = None, *, model: str = _DEFAULT_GEMINI_MODEL):
        try:
            from google import genai
        except ImportError as e:
            raise WikiLLMError("the 'google-genai' package is required — install with: uv add google-genai") from e
        # Resolve key from the GEMINI_API_KEY or GOOGLE_API_KEY env var as a
        # fallback (the SDK itself accepts either).
        key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not key:
            raise WikiLLMError("Gemini API key missing — pass api_key= or set $GEMINI_API_KEY.")
        self._client = genai.Client(api_key=key)
        self._model = model

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

        response = _retry_call(_do, classify=_classify, label="gemini")
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


def make_llm(
    provider: str,
    *,
    api_key: str | None = None,
    model: str | None = None,
) -> WikiLLM:
    """Construct a :class:`WikiLLM` for the requested provider.

    Provider must be one of :data:`SUPPORTED_PROVIDERS`. ``model`` overrides
    the per-provider default.
    """
    if provider == PROVIDER_ANTHROPIC:
        return AnthropicLLM(api_key=api_key, model=model or _DEFAULT_ANTHROPIC_MODEL)
    if provider == PROVIDER_GEMINI:
        return GeminiLLM(api_key=api_key, model=model or _DEFAULT_GEMINI_MODEL)
    raise WikiLLMError(f"unsupported provider {provider!r} — choose one of {SUPPORTED_PROVIDERS}")
