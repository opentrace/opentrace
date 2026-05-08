# Wiki Providers

OpenTrace's wiki/vault compiler turns uploaded files into a folder of interconnected markdown pages by driving an LLM through a structured Plan + Execute loop. The same four providers chat supports also drive vault compilation.

Compilation is fully BYOK — your key is sent only to the provider you select, never to OpenTrace servers. The UI reuses the keys you already entered for chat (stored in your browser's `localStorage`); the CLI takes them via flag or environment variable.

## Anthropic

Provides access to the Claude model family.

**Default model:** `claude-sonnet-4-20250514`

Supply the key with `--api-key` or the `ANTHROPIC_API_KEY` environment variable.

```bash
opentraceai wiki compile myvault file1.pdf --provider anthropic
```

To get an API key, visit the [Anthropic Console](https://platform.claude.com/settings/keys).

## Google Gemini

Provides access to the Gemini model family.

**Default model:** `gemini-2.5-flash`

Supply the key with `--api-key` or either `GEMINI_API_KEY` / `GOOGLE_API_KEY` (the SDK accepts either).

```bash
opentraceai wiki compile myvault file1.pdf --provider gemini
```

To get an API key, visit [Google AI Studio](https://aistudio.google.com/apikey).

## OpenAI

Provides access to GPT and reasoning models.

**Default model:** `gpt-4.1-mini`

Supply the key with `--api-key` or the `OPENAI_API_KEY` environment variable.

```bash
opentraceai wiki compile myvault file1.pdf --provider openai
```

To get an API key, visit the [OpenAI Platform](https://platform.openai.com/api-keys).

## Local LLM

Use any OpenAI-compatible local server such as [Ollama](https://ollama.com/), llama.cpp, or vLLM.

**Default model:** `llama3.2` (override with `--model` to match what your server hosts)

No API key is required, but you must point the compiler at the server's base URL with `--base-url` or the `OT_LOCAL_LLM_URL` environment variable. The compiler appends `/v1` if you omit it.

```bash
opentraceai wiki compile myvault file1.pdf \
    --provider local \
    --base-url http://localhost:11434 \
    --model llama3.2
```

Tool-calling support varies by model — pick one whose model card lists OpenAI-compatible function calling. Models without it will fail at the Plan stage.

## Provider auto-detection

If you omit `--provider`, the CLI picks one based on which environment variable is set, in priority order:

1. `ANTHROPIC_API_KEY` → `anthropic`
2. `GEMINI_API_KEY` or `GOOGLE_API_KEY` → `gemini`
3. `OPENAI_API_KEY` → `openai`
4. otherwise → `anthropic` (so you get a clear "key missing" error)

Local is never auto-selected — it always needs an explicit `--provider local`, since the compiler can't tell whether `OT_LOCAL_LLM_URL` is the user's intent or a stale shell setting.

## UI flow

The `Add vault…` modal in the browser reads the same `localStorage` slot the chat panel uses, so once you've entered a key in **Chat → Settings**, the vault modal picks it up automatically. Switch the **Provider** dropdown in the modal to use a different one — no second key entry. For the local provider, the modal also reads the local LLM URL you configured for chat.

The UI talks to a running `opentraceai serve` process; the agent forwards your key to the provider but does not persist it. CLI users bypass the server entirely.

## Privacy

- Keys you enter in the UI live in browser `localStorage` only.
- For UI compiles, the key is sent to your local `opentraceai serve` over the multipart compile request, then forwarded to the upstream provider. It is never written to disk by the agent.
- For CLI compiles, the key stays in your shell environment or the flag value you passed.
- Source bytes are not retained after a compile — only sha256 hashes of each input. See the [architecture overview](../architecture/overview.md) for vault storage details.
