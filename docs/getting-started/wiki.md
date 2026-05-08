# Wiki & Vaults

The wiki feature compiles a folder of uploaded files (PDFs, markdown, slides, transcripts, …) into a vault — an interconnected set of markdown pages summarising the inputs and linking them together with `[[wiki-link]]` references. Vaults are mirrored into the same knowledge graph as your code, so retrieval tools can pull from both surfaces.

This page covers the two ways to compile a vault:

- **CLI** — `opentraceai wiki compile`. Self-contained; needs only an API key.
- **UI** — the **Add vault…** modal. Talks to a running `opentraceai serve`.

For the full provider list, models, and env-var reference, see [Wiki Providers](../reference/wiki-providers.md).

## Prerequisites

- `opentraceai` installed — see the [CLI install guide](install-cli.md).
- An API key from one of the [supported providers](../reference/wiki-providers.md), **or** a local OpenAI-compatible server (Ollama, llama.cpp, vLLM).

## CLI

Compile one or more files **or folders** into a named vault. The vault is created on first use and reused on subsequent calls (sha256 dedup means re-uploading the same file is a no-op).

```bash
# individual files
opentraceai wiki compile myvault notes.pdf transcript.md

# a whole folder, walked recursively
opentraceai wiki compile myvault ~/research

# a mix of both
opentraceai wiki compile myvault ~/research/intro.md ~/research/papers
```

When walking a folder, the compiler skips common cache and VCS directories by default (`.git`, `node_modules`, `__pycache__`, `.venv`, `.opentrace`, …) and dotfiles. Filter further with repeated `--include` / `--exclude` fnmatch globs:

```bash
# only markdown and PDFs
opentraceai wiki compile myvault ~/research --include '*.md' --include '*.pdf'

# everything except drafts
opentraceai wiki compile myvault ~/research --exclude 'draft-*'

# include dotfiles + bypass the default excludes (rarely what you want)
opentraceai wiki compile myvault ~/notes --hidden --no-default-excludes
```

Globs match against both the file's basename and its path relative to the input root, so `--include 'docs/*'` keeps only files directly under a `docs/` folder.

By default the compiler picks a provider from your environment, in priority order: `$ANTHROPIC_API_KEY` → `$GEMINI_API_KEY`/`$GOOGLE_API_KEY` → `$OPENAI_API_KEY`, falling back to Anthropic. Override with `--provider`.

### Examples

=== "Anthropic (default)"

    ```bash
    export ANTHROPIC_API_KEY=sk-ant-...
    opentraceai wiki compile myvault notes.pdf
    ```

=== "OpenAI"

    ```bash
    opentraceai wiki compile myvault notes.pdf \
        --provider openai \
        --api-key sk-...
    ```

=== "Gemini"

    ```bash
    export GEMINI_API_KEY=...
    opentraceai wiki compile myvault notes.pdf --provider gemini
    ```

=== "Local (Ollama)"

    ```bash
    opentraceai wiki compile myvault notes.pdf \
        --provider local \
        --base-url http://localhost:11434 \
        --model llama3.2
    ```

### Useful flags

| Flag                    | Purpose                                                                 |
|-------------------------|-------------------------------------------------------------------------|
| `--include GLOB`        | Only walk files matching this fnmatch pattern. Repeatable.              |
| `--exclude GLOB`        | Skip files matching this fnmatch pattern. Repeatable.                   |
| `--no-default-excludes` | Don't auto-skip `.git`, `node_modules`, etc.                            |
| `--hidden`              | Include dotfiles and files inside dotfile-prefixed directories.         |
| `--provider`            | `anthropic`, `gemini`, `openai`, or `local`. Auto-detected if omitted.  |
| `--api-key`             | Provider key. Falls back to the matching env var (see above).           |
| `--model`               | Override the provider's default model.                                  |
| `--base-url`            | Required for `--provider local` (or set `OT_LOCAL_LLM_URL`).            |
| `--vault-root`          | Where vaults are stored on disk. Defaults to `~/.opentrace/vaults`.     |
| `--no-graph`            | Skip mirroring the vault into the graph (disk only).                    |
| `--db`                  | Path to the graph DB to mirror into. Auto-discovered if omitted.        |

### Inspecting vaults

List every vault under the root, with page counts and last-compile timestamps:

```bash
opentraceai wiki list
```

Show the page index for one vault — title, slug, kind, and one-line summary per page:

```bash
opentraceai wiki show myvault
```

Print a single page's markdown body to stdout (useful with `less` or `pbcopy`):

```bash
opentraceai wiki show myvault --page some-slug
```

### Re-syncing a vault into the graph

If you compiled a vault with `--no-graph` (or before the graph mirror existed), you can mirror an existing vault into the graph without re-running the LLM:

```bash
opentraceai wiki backfill myvault
```

## UI

The browser flow needs a running agent server because compilation requires LLM access and disk writes that the browser can't perform on its own:

```bash
opentraceai serve
```

Then in the UI:

1. Open **Chat → Settings** and enter an API key for at least one provider. (For local: also set the local LLM URL.) The same keys are reused for chat and vault compilation.
2. Open the **wiki panel** and click **Add vault…**.
3. Pick a **Provider**, a target vault (existing or new), and drop in your files or a folder.
4. Click **Compile**. Progress streams as the pipeline runs through Acquire → Normalize → Plan → Execute → Persist.

The modal disables the **Compile** button until you have a key (or local URL) and at least one file selected. If you switch providers, the modal re-checks against the keys stored for that provider.

## Where vaults live

```
~/.opentrace/vaults/<vault-name>/
  pages/<slug>.md       — the compiled markdown pages
  .vault.json           — page metadata + sha256 dedup state
  .compile-log/<ts>.json — compile history
```

Override the root with the `OT_VAULT_ROOT` environment variable.

Disk is the source of truth for page bodies; the knowledge graph holds metadata and relationships only.

## What Next

- **Pick a provider** → [Wiki Providers](../reference/wiki-providers.md)
- **Browse the graph the wiki feeds into** → [Graph Tools](../reference/graph-tools.md)
- **Hit a problem?** → [Troubleshooting](troubleshooting.md)
