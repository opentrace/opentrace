# Chat Providers

OpenTrace's built-in chat assistant supports multiple LLM providers. Bring your own API key, select a provider, and start querying your knowledge graph.

All API keys are stored locally in your browser — they are never sent to OpenTrace servers.

## Anthropic

Provides access to the Claude model family.

**Available models:** Claude Opus 4, Claude Sonnet 4.5, Claude Sonnet 4, Claude Haiku 3.5

To get an API key, visit the [Anthropic Console](https://console.anthropic.com/).

See the [Anthropic API documentation](https://docs.anthropic.com/en/api/getting-started) for details on plans, pricing, and usage.

## OpenAI

Provides access to GPT and reasoning models.

**Available models:** o3, o4-mini, GPT-4.1, GPT-4.1 Mini, GPT-4.1 Nano, GPT-4o, GPT-4o Mini

To get an API key, visit the [OpenAI Platform](https://platform.openai.com/api-keys).

See the [OpenAI API documentation](https://platform.openai.com/docs/overview) for details on plans, pricing, and usage.

## Google Gemini

Provides access to the Gemini model family.

**Available models:** Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 Flash

To get an API key, visit [Google AI Studio](https://aistudio.google.com/apikey).

See the [Gemini API documentation](https://ai.google.dev/gemini-api/docs) for details on plans, pricing, and usage.

## Local LLM

Use any OpenAI-compatible local server such as [Ollama](https://ollama.com/).

**Default model:** `llama3.2` (you can enter any model name your server supports)

No API key is required. Instead, configure the base URL of your local server (e.g. `http://localhost:11434` for Ollama).

See the [Ollama documentation](https://github.com/ollama/ollama/blob/main/README.md) for setup instructions.
