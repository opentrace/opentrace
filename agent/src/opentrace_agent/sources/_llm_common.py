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

"""Shared LLM backend registry used by both wiki ingest and generic ingest.

Two protocols live on top of this module:

* ``wiki.llm.WikiLLM.call_tool`` — forced tool-calling for structured
  output (the wiki ingest per-doc label pass).
* ``sources.markdown.clients.LLMClient.complete`` — plain text completion
  with reject-not-repair JSON validation (``opentraceai ingest``).

The protocols are deliberately different — wiki gets server-side schema
guarantees from tool-calling, generic ingest gets the broader model
support that comes from a text-only API. They share *everything else*:
provider name, default model, env var conventions, pricing, autodetect
order, actionable error messages. That shared state lives here.

Backend names: ``anthropic`` / ``gemini`` / ``openai`` / ``kimi`` / ``local``.
``"claude"`` and ``"ollama"`` are accepted as aliases for backward
compatibility with the experiment's original ingest CLI.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class BackendConfig:
    """One row of the backend registry."""

    name: str
    env_keys: tuple[str, ...]
    default_model: str
    pricing_input_per_million: float
    pricing_output_per_million: float
    base_url: str | None = None  # None for Anthropic-SDK path
    model_env_var: str | None = None  # override model via env var
    # Cheaper model used for the ``extraction`` role (a strict-JSON task
    # that doesn't need the flagship model). None → fall back to default_model,
    # which is correct for backends whose default is already a cheap tier.
    extraction_model: str | None = None
    # Pricing for ``extraction_model``, USD per 1M tokens. Separate from the
    # flagship pair above because the two differ by ~3x and doc ingestion runs
    # ENTIRELY on the extraction tier — costing it at flagship rates overstated
    # the pre-ingest estimate by that factor. None → the extraction model is the
    # default model, so the flagship pair already applies.
    extraction_pricing_input_per_million: float | None = None
    extraction_pricing_output_per_million: float | None = None
    # Hard ceiling on a single response's output tokens for this backend's
    # models. Callers clamp their requested ``max_tokens`` to this so a large
    # request never exceeds a provider's model limit (which would error). Set
    # conservatively for backends whose ceiling we can't verify (Kimi/local).
    max_output_tokens: int = 8192


# Pricing pulled from each provider's published rates as of session start.
# Numbers are USD per 1M tokens. They drift; treat the per-run cost reports
# as estimates rather than billing oracles.
BACKENDS: dict[str, BackendConfig] = {
    "anthropic": BackendConfig(
        name="anthropic",
        env_keys=("ANTHROPIC_API_KEY",),
        default_model="claude-sonnet-4-6",
        pricing_input_per_million=3.0,
        pricing_output_per_million=15.0,
        model_env_var="OT_LLM_MODEL_ANTHROPIC",
        extraction_model="claude-haiku-4-5",
        extraction_pricing_input_per_million=1.0,  # Haiku 4.5
        extraction_pricing_output_per_million=5.0,
        max_output_tokens=64000,  # Sonnet 4.6 + Haiku 4.5 both support 64k
    ),
    "gemini": BackendConfig(
        name="gemini",
        env_keys=("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        # Flagship (code extraction) → Pro; cheap per-doc doc pass → Flash.
        default_model="gemini-2.5-pro",
        pricing_input_per_million=1.25,
        pricing_output_per_million=10.00,
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model_env_var="OT_LLM_MODEL_GEMINI",
        extraction_model="gemini-2.5-flash",
        extraction_pricing_input_per_million=0.30,  # Gemini 2.5 Flash
        extraction_pricing_output_per_million=2.50,
        max_output_tokens=64000,  # Gemini 2.5 Pro/Flash support 64k+ output
    ),
    "kimi": BackendConfig(
        name="kimi",
        env_keys=("MOONSHOT_API_KEY",),
        default_model="kimi-k2.6",
        pricing_input_per_million=0.74,
        pricing_output_per_million=4.66,
        base_url="https://api.moonshot.ai/v1",
        model_env_var="OT_LLM_MODEL_KIMI",
        max_output_tokens=16384,  # conservative — Moonshot's ceiling unverified
    ),
    "openai": BackendConfig(
        name="openai",
        env_keys=("OPENAI_API_KEY",),
        # Flagship (code extraction) → gpt-4.1; cheap per-doc doc pass → mini.
        default_model="gpt-4.1",
        pricing_input_per_million=2.00,
        pricing_output_per_million=8.00,
        base_url="https://api.openai.com/v1",
        model_env_var="OT_LLM_MODEL_OPENAI",
        extraction_model="gpt-4.1-mini",
        extraction_pricing_input_per_million=0.40,  # gpt-4.1-mini
        extraction_pricing_output_per_million=1.60,
        max_output_tokens=32768,  # gpt-4.1 / gpt-4.1-mini cap
    ),
    "local": BackendConfig(
        # OpenAI-compatible local endpoint (Ollama / llama.cpp / vLLM).
        # The env signal is OT_LOCAL_LLM_URL / OLLAMA_BASE_URL, not a key.
        name="local",
        env_keys=(),
        default_model="qwen2.5-coder:7b",
        pricing_input_per_million=0.0,
        pricing_output_per_million=0.0,
        base_url="http://localhost:11434/v1",
        model_env_var="OT_LLM_MODEL_LOCAL",
    ),
}

# Priority order for autodetection. Paid backends first; local last so it
# can't shadow a paid key.
_BACKEND_PRIORITY: tuple[str, ...] = ("anthropic", "gemini", "kimi", "openai", "local")

# Legacy alias map — old names from the experiment's first ingest pass.
# Callers passing these (e.g. ``opentraceai ingest --provider claude``) get
# translated to the current canonical name before any registry lookup.
_LEGACY_ALIASES: dict[str, str] = {
    "claude": "anthropic",
    "ollama": "local",
}


def canonical_backend(name: str) -> str:
    """Map a user-facing provider name to its canonical BACKENDS key.

    Accepts canonical names (``anthropic``, ``local``, ...) and the
    deprecated aliases (``claude``, ``ollama``). Unknown names pass through
    unchanged so the caller can raise its own "unknown provider" error
    with a list of known names.
    """
    return _LEGACY_ALIASES.get(name, name)


def _has_env_key(cfg: BackendConfig) -> bool:
    return any(os.environ.get(k) for k in cfg.env_keys)


def detect_backend() -> str | None:
    """Return the name of whichever backend has a usable env signal.

    Order: ``OT_LLM_PROVIDER`` (explicit override) → anthropic → gemini → kimi
    → openai → local. The first paid backend with a key wins. Local is only
    considered if ``OLLAMA_BASE_URL`` (or ``OT_LOCAL_LLM_URL``) is set *and*
    no paid backend has a key — this avoids silently routing to a local model
    when the user thought they were paying for Claude.

    The override knob lets users pin a provider across a shell session without
    having to unset other API keys. Set ``OT_LLM_PROVIDER=gemini`` to force
    Gemini even when ``ANTHROPIC_API_KEY`` is also set. Unknown values fall
    through to autodetect (so a typo doesn't silently kill all LLM features).
    """
    override = (os.environ.get("OT_LLM_PROVIDER") or "").strip().lower()
    if override:
        canonical = canonical_backend(override)
        if canonical in BACKENDS:
            cfg = BACKENDS[canonical]
            if canonical == "local":
                if os.environ.get("OLLAMA_BASE_URL") or os.environ.get("OT_LOCAL_LLM_URL"):
                    return "local"
            elif _has_env_key(cfg):
                return canonical
            # Override named a known backend but its key is missing — fall
            # through to autodetect so we either pick a viable backend or
            # surface the actionable no-backend message.

    for backend in _BACKEND_PRIORITY[:-1]:  # everything except local
        if _has_env_key(BACKENDS[backend]):
            return backend
    if os.environ.get("OLLAMA_BASE_URL") or os.environ.get("OT_LOCAL_LLM_URL"):
        return "local"
    return None


# Role-specific model overrides. These let the LLM workloads diverge: the
# per-doc label pass (``wiki_summary``) and strict code ``extraction`` run on
# the cheap tier, while ``wiki`` keeps the flagship one. Checked ahead of the
# generic per-backend OT_LLM_MODEL_* var. ``wiki`` had one caller — concept-page
# synthesis, removed 2026-08-03 — so it is now only reachable by a caller
# passing ``role="wiki"`` explicitly.
_ROLE_MODEL_ENV: dict[str, str] = {
    "extraction": "OT_EXTRACTION_MODEL",
    "wiki": "OT_WIKI_MODEL",
    "wiki_summary": "OT_WIKI_SUMMARY_MODEL",
}

# Roles that default to the backend's cheap tier (a strict-distillation task,
# not flagship-worthy) when no explicit/env override is set.
_CHEAP_TIER_ROLES = frozenset({"extraction", "wiki_summary"})


def resolve_model(backend: str, override: str | None, *, role: str | None = None) -> str:
    """Pick a model name for *backend*.

    Precedence: explicit ``override`` → role-specific env
    (``OT_EXTRACTION_MODEL`` / ``OT_WIKI_MODEL`` / ``OT_WIKI_SUMMARY_MODEL``) →
    generic per-backend env (``OT_LLM_MODEL_<BACKEND>``) → role default
    (``extraction_model`` for cheap-tier roles, when the backend defines one) →
    ``default_model``.

    ``role=None`` reproduces the historical behaviour exactly.
    """
    cfg = BACKENDS[canonical_backend(backend)]
    if override:
        return override
    role_env = _ROLE_MODEL_ENV.get(role or "")
    if role_env:
        from_role_env = os.environ.get(role_env)
        if from_role_env:
            return from_role_env
    if cfg.model_env_var:
        from_env = os.environ.get(cfg.model_env_var)
        if from_env:
            return from_env
    if role in _CHEAP_TIER_ROLES and cfg.extraction_model:
        return cfg.extraction_model
    return cfg.default_model


def resolve_api_key(backend: str) -> str:
    """Pick the first non-empty env key listed for *backend*, or ``""``."""
    cfg = BACKENDS[canonical_backend(backend)]
    for k in cfg.env_keys:
        v = os.environ.get(k)
        if v:
            return v
    return ""


def resolve_base_url(backend: str, override: str | None = None) -> str:
    """Pick a base URL: explicit override → env (local only) → registry default."""
    canonical = canonical_backend(backend)
    cfg = BACKENDS[canonical]
    if override:
        return override
    if canonical == "local":
        from_env = os.environ.get("OT_LOCAL_LLM_URL") or os.environ.get("OLLAMA_BASE_URL")
        if from_env:
            return from_env
    return cfg.base_url or ""


def _cost_usd(cfg: BackendConfig, input_tokens: int, output_tokens: int) -> float:
    return (input_tokens / 1_000_000.0) * cfg.pricing_input_per_million + (
        output_tokens / 1_000_000.0
    ) * cfg.pricing_output_per_million


def estimate_cost(backend: str, input_tokens: int, output_tokens: int) -> float:
    """Return USD cost estimate for *backend* given a token count."""
    cfg = BACKENDS.get(canonical_backend(backend))
    if cfg is None:
        return 0.0
    return _cost_usd(cfg, input_tokens, output_tokens)


def actionable_no_backend_message() -> str:
    """The error string we print when an LLM-required feature has no backend.

    Lists every env var the user could set to enable a backend. Kept in this
    module so the listing stays in lockstep with ``BACKENDS``.
    """
    lines = ["No LLM backend configured. Set one of:"]
    for backend in _BACKEND_PRIORITY[:-1]:
        cfg = BACKENDS[backend]
        keys = " or ".join(cfg.env_keys)
        lines.append(f"  {keys}  ({backend})")
    lines.append("  OLLAMA_BASE_URL or OT_LOCAL_LLM_URL  (local)")
    lines.append("")
    lines.append(
        "Plain `opentraceai index <path>` works without a key. A key is only "
        "required when you opt into doc ingestion with --wiki."
    )
    return "\n".join(lines)


def resolve_timeout(default: float) -> float:
    """Read ``OT_LLM_TIMEOUT`` seconds; fall back to *default* on missing/invalid."""
    raw = os.environ.get("OT_LLM_TIMEOUT", "").strip()
    if raw:
        try:
            v = float(raw)
            if v > 0:
                return v
        except ValueError:
            pass
    return default


def resolve_max_retries(default: int = 6) -> int:
    """Read ``OT_LLM_MAX_RETRIES``; fall back to *default* on missing/invalid.

    Bounds how many times a rate-limited (429/529) LLM call is retried before
    giving up. The parallel extraction stage owns the retry loop (so it can
    also throttle concurrency), so it sets the SDK's own retries to 0 and uses
    this value instead.
    """
    raw = os.environ.get("OT_LLM_MAX_RETRIES", "").strip()
    if raw:
        try:
            v = int(raw)
            if v >= 0:
                return v
        except ValueError:
            pass
    return default


def extraction_pricing(backend: str) -> tuple[float, float] | None:
    """``(input, output)`` USD per 1M tokens for *backend*'s extraction tier.

    Falls back to the flagship pair when the backend has no separate cheap
    model (its default already is one). ``None`` for an unknown backend.

    Exists so cost estimates price the model that actually runs. Doc ingestion
    is entirely extraction-tier work, and quoting it at flagship rates
    overstated the pre-ingest estimate roughly 3x — on the one screen whose
    whole job is letting someone decide whether to spend.
    """
    cfg = BACKENDS.get(backend)
    if cfg is None:
        return None
    if cfg.extraction_model is None:
        return cfg.pricing_input_per_million, cfg.pricing_output_per_million
    return (
        cfg.extraction_pricing_input_per_million
        if cfg.extraction_pricing_input_per_million is not None
        else cfg.pricing_input_per_million,
        cfg.extraction_pricing_output_per_million
        if cfg.extraction_pricing_output_per_million is not None
        else cfg.pricing_output_per_million,
    )
