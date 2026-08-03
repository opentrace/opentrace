# Wiki Providers

OpenTrace's wiki/vault compiler uses an LLM to label and index your documents into the graph. That is **one call per document** and the only LLM work the compiler does — bodies are never rewritten. Five providers are supported, all BYOK — your key is sent only to the provider you select, never to OpenTrace servers.

Because the one call is a compact extraction task (a one-line summary + an entity inventory) rather than prose generation, it runs on each backend's **cheap tier** by default.

## Anthropic

Claude model family.

**Model:** `claude-haiku-4-5` for doc ingestion (`claude-sonnet-4-6` is the backend default, used where a caller asks for the flagship tier)

Supply the key via the `ANTHROPIC_API_KEY` env var:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
opentraceai index ./papers myvault --wiki
```

Get a key at the [Anthropic Console](https://platform.claude.com/settings/keys).

## Google Gemini

Gemini model family.

**Model:** `gemini-2.5-flash` for doc ingestion (`gemini-2.5-pro` is the backend default)

Supply the key via `GEMINI_API_KEY` (or `GOOGLE_API_KEY` — the SDK accepts both):

```bash
export GEMINI_API_KEY=...
opentraceai index ./papers myvault --wiki
```

If another paid key is also set in your shell, pin Gemini with `OT_LLM_PROVIDER=gemini` (see [Provider auto-detection](#provider-auto-detection)).

Get a key at [Google AI Studio](https://aistudio.google.com/apikey).

## OpenAI

GPT and reasoning models.

**Model:** `gpt-4.1-mini` for doc ingestion (`gpt-4.1` is the backend default)

```bash
export OPENAI_API_KEY=sk-...
opentraceai index ./papers myvault --wiki
```

Get a key at the [OpenAI Platform](https://platform.openai.com/api-keys).

## Moonshot Kimi

Kimi models via Moonshot's OpenAI-compatible endpoint.

**Default model:** `kimi-k2.6` (no separate cheap tier — one model for everything)
**Base URL:** `https://api.moonshot.ai/v1` (auto-set)

```bash
export MOONSHOT_API_KEY=...
export OT_LLM_PROVIDER=kimi   # required — Kimi is never auto-selected
opentraceai index ./papers myvault --wiki
```

## Local LLM

Any OpenAI-compatible local server — [Ollama](https://ollama.com/), llama.cpp, vLLM, LM Studio, etc.

**Default model:** `qwen2.5-coder:7b` (override with `OT_LLM_MODEL_LOCAL`)

No API key required, but you must point the compiler at the server's base URL with `OT_LOCAL_LLM_URL` (or `OLLAMA_BASE_URL`). The CLI appends `/v1` if you omit it.

```bash
export OT_LOCAL_LLM_URL=http://localhost:11434
export OT_LLM_MODEL_LOCAL=llama3.2
export OT_LLM_PROVIDER=local   # required when paid keys are also set
opentraceai index ./papers myvault --wiki
```

Commands that take per-call provider flags (e.g. `vault ingest`) accept `--provider local --base-url ... --model ...` for one-off overrides.

!!! note "Tool-calling support varies"
    The extraction call uses forced tool-calling for structured output, so a local model without OpenAI-compatible function calling will fail. Pick a model whose card lists tool-calling support.

## Provider auto-detection

When a command doesn't take an explicit `--provider` (e.g. `opentraceai index`), the CLI decides which backend to use in this order:

1. **`OT_LLM_PROVIDER`** override, if set to a known backend name (`anthropic` / `gemini` / `kimi` / `openai` / `local`) AND that backend's key/URL is present.
2. **Env-var precedence** over the remaining backends:
    1. `ANTHROPIC_API_KEY` → `anthropic`
    2. `GEMINI_API_KEY` or `GOOGLE_API_KEY` → `gemini`
    3. `MOONSHOT_API_KEY` → `kimi`
    4. `OPENAI_API_KEY` → `openai`
3. **Local fallback** — `OLLAMA_BASE_URL` or `OT_LOCAL_LLM_URL` set *and* none of the paid backends configured → `local`. This avoids silently routing to a local model when you thought you were paying for Claude.

If **none** of the above resolve, the command **hard-fails** with an actionable message:

```
No LLM backend configured. Set one of:
  ANTHROPIC_API_KEY  (anthropic)
  GEMINI_API_KEY or GOOGLE_API_KEY  (gemini)
  MOONSHOT_API_KEY  (kimi)
  OPENAI_API_KEY  (openai)
  OLLAMA_BASE_URL or OT_LOCAL_LLM_URL  (local)
```

### Pinning a provider with `OT_LLM_PROVIDER`

When multiple API keys are set in your shell (e.g. both Anthropic and Gemini), the precedence list above always picks Anthropic. To pin a different backend without unsetting other keys:

```bash
export OT_LLM_PROVIDER=gemini
opentraceai index ./papers --wiki
# → routes through Gemini even though ANTHROPIC_API_KEY is also set
```

Scope is the shell session — `unset OT_LLM_PROVIDER` returns to precedence. If the override names a known backend but that backend's key is missing, the CLI falls through to precedence (a typo doesn't silently kill all LLM features).

## Cost estimates

Before any LLM work, the CLI prints a pre-flight estimate:

```
Running wiki ingestion on 142 docs via anthropic (~$0.85 estimated)
```

The estimate uses each backend's `pricing_input_per_million` / `pricing_output_per_million` from a shared registry — accurate to ±50% depending on actual token counts. Treat it as a budget signal, not billing.

Set `OT_LLM_TIMEOUT=<seconds>` to override the default per-call timeout (defaults to 600s for local backends, lower for hosted).

## Model overrides via env

Each backend supports a per-backend model override env var:

| Variable | Overrides |
|---|---|
| `OT_LLM_MODEL_ANTHROPIC` | Anthropic's default model |
| `OT_LLM_MODEL_GEMINI` | Gemini's default model |
| `OT_LLM_MODEL_OPENAI` | OpenAI's default model |
| `OT_LLM_MODEL_KIMI` | Kimi's default model |
| `OT_LLM_MODEL_LOCAL` | Local server's default model |

There is also a role-specific override, checked **ahead** of the per-backend var:

| Variable | Overrides |
|---|---|
| `OT_WIKI_SUMMARY_MODEL` | The model used for the per-doc extraction call — i.e. the only LLM call `index --wiki` / `vault ingest` makes |

Two sibling role vars exist in the registry (`OT_EXTRACTION_MODEL`, `OT_WIKI_MODEL`) but no code path in the current pipeline reads them — they were the flagship/synthesis tier for the concept-page stage that was removed. Setting them has no effect on doc ingestion.

## UI flow

The `Add vault…` modal in the browser reads the same `localStorage` slot the chat panel uses — once a key is entered in **Chat → Settings**, the vault modal picks it up. The UI talks to a running `opentraceai serve`; the agent forwards your key to the provider but does not persist it.

## Privacy

- Keys you enter in the UI live in browser `localStorage` only
- For UI compiles, the key is sent to your local `opentraceai serve` over the compile request, then forwarded upstream. Never written to disk
- For CLI compiles, the key stays in your shell environment or the flag value you passed
- Document bodies after markitdown conversion are stored at `.opentrace/corpus/<sha>.md` to support re-extraction and grep — raw original bytes are not retained
