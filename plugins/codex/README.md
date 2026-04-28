# OpenTrace — Codex CLI marketplace

This directory is an installable [Codex CLI](https://developers.openai.com/codex)
plugin marketplace that ships one plugin: **OpenTrace**. The plugin exposes
OpenTrace's knowledge-graph MCP server (eleven tools) to Codex and adds
seven skills covering indexing, graph status, component exploration,
read-only codebase interrogation, usage-finding, blast-radius analysis,
and CLI updates.

## Install

Installation is **three steps**:
1. Register the marketplace (shell)
2. Enable the plugin from inside Codex (`/plugins`)
3. Optional but recommended — install hooks (`./install.sh --home`)

Steps 1+2 give you the MCP tools and skills. Step 3 adds the
session-start guidance, periodic graph briefings, and shell-search
augmentation that keep Codex from defaulting to `rg`/`grep` mid-session.

### 1. Register the marketplace

From a local OpenTrace checkout:

```bash
git clone https://github.com/opentrace/opentrace.git
cd opentrace
codex plugin marketplace add ./plugins/codex
```

Directly from GitHub (sparse checkout):

```bash
codex plugin marketplace add https://github.com/opentrace/opentrace --sparse plugins/codex
```

Either command writes a `[marketplaces.opentrace-oss]` stanza to
`~/.codex/config.toml`. It does **not** enable the plugin inside —
third-party marketplaces require explicit user activation.

### 2. Enable the plugin from inside Codex

```bash
codex
```

In the session, run:

```
/plugins
```

Install/enable `opentrace` from the `opentrace-oss` marketplace. After this,
`~/.codex/config.toml` gains a `[plugins."opentrace@opentrace-oss"]` stanza
with `enabled = true`, and Codex starts the MCP server (`uvx opentraceai mcp`)
on next session launch.

### Verify

```bash
grep -A 2 '\[plugins\.' ~/.codex/config.toml
# → expect [plugins."opentrace@opentrace-oss"] with enabled = true
```

### 3. Install hooks (recommended)

The plugin alone gives Codex MCP tools and skills, but the model still
tends to default to shell `rg`/`grep`/`cat` for ambiguous prompts. The
hooks fix that by injecting OpenTrace tool-routing guidance at session
start, periodically reminding the model of the graph state, and
augmenting shell rg/grep/cat calls with graph context inline.

```bash
# From the OpenTrace checkout root
./plugins/codex/install.sh --home
```

This copies hook scripts to `~/.codex/hooks/`, writes
`~/.codex/hooks.json`, and ensures `codex_hooks = true` is set under
`[features]` in `~/.codex/config.toml`. Idempotent — re-run any time.
Add `--force` to overwrite hooks from a previous install (e.g. another
Codex plugin's hooks).

Per-repo install (only affects sessions launched from that repo):

```bash
./plugins/codex/install.sh --repo /path/to/project
```

Symlink mode for plugin development (changes to `plugins/codex/.codex/`
take effect without re-running the installer):

```bash
./plugins/codex/install.sh --home --mode symlink
```

### Disable / remove

Disable without uninstalling (edit `~/.codex/config.toml`):

```toml
[plugins."opentrace@opentrace-oss"]
enabled = false
```

Or remove the marketplace entirely:

```bash
codex plugin marketplace remove opentrace-oss
```

To remove the hooks, delete `~/.codex/hooks/{common,session_start,user_prompt_submit,pre_tool_use}.py`
(and revert `~/.codex/hooks.json` if you want to remove the routing
config).

## Prerequisites

- [`uv`](https://docs.astral.sh/uv/) on your PATH — the plugin shells out to
  `uvx opentraceai` for the MCP server and the indexer.
- A repo that has been indexed by OpenTrace. Run `uvx opentraceai index .`
  once at the repo root, or use the `opentrace-index` skill inside Codex.

## Layout

```
plugins/codex/                             # marketplace root
├── .agents/plugins/marketplace.json       # marketplace manifest (registers opentrace)
├── .codex/                                # hook bundle (copied to ~/.codex/ by install.sh)
│   ├── config.toml                        # feature flag template
│   ├── hooks.json                         # SessionStart / UserPromptSubmit / PreToolUse config
│   └── hooks/
│       ├── common.py                      # shared utilities (db discovery, CLI runner, parsers)
│       ├── session_start.py               # primes Codex with tool-routing directive at start
│       ├── user_prompt_submit.py          # injects periodic graph briefing (10-min TTL)
│       └── pre_tool_use.py                # augments shell rg/grep/cat with graph context
├── plugins/opentrace/                     # the plugin bundle
│   ├── .codex-plugin/plugin.json          # plugin manifest (name, version, interface)
│   ├── .mcp.json                          # MCP server wiring (uvx opentraceai mcp)
│   ├── skills/                            # 7 skills (SKILL.md each)
│   │   ├── opentrace-explore/
│   │   ├── opentrace-find-usages/
│   │   ├── opentrace-graph-status/
│   │   ├── opentrace-impact/
│   │   ├── opentrace-index/
│   │   ├── opentrace-interrogate/
│   │   └── opentrace-update/
│   └── README.md                          # per-plugin docs
├── scripts/
│   └── install_codex_integration.py       # backend for install.sh
├── install.sh                             # one-line wrapper for the hook installer
└── README.md                              # this file
```

## Testing against a local checkout

```bash
# 1. Index a test repo
cd ~/your-test-repo
uvx opentraceai index .
ls .opentrace/index.db

# 2. Add this marketplace against your OpenTrace checkout
cd /path/to/opentrace
codex plugin marketplace add ./plugins/codex

# 3. Launch Codex inside the indexed repo
cd ~/your-test-repo
codex

# 4. Try some prompts:
#    "Show me the opentrace graph status"            → opentrace-graph-status
#    "Explore the UserService"                       → opentrace-explore
#    "Who calls parse_request?"                      → opentrace-find-usages
#    "What breaks if I change db.py?"                → opentrace-impact
#    "How does the indexing pipeline work?"          → opentrace-interrogate
#    "Update opentraceai"                            → opentrace-update
```

## Uninstall

```bash
codex plugin marketplace remove opentrace-oss
```

## Related

- Plugin details and limitations: [`plugins/opentrace/README.md`](./plugins/opentrace/README.md)
- OpenTrace docs: [opentrace.github.io/opentrace](https://opentrace.github.io/opentrace/)
- Claude Code equivalent: [`../claude-code/`](../claude-code/)