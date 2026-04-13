# Troubleshooting

Common install issues and how to fix them.

## `command not found: uvx`

The plugin and the "try without installing" CLI path both need [`uv`](https://docs.astral.sh/uv/) (which provides `uvx`).

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then open a new shell (or `source` your profile) so `uvx` is on `PATH`.

## `command not found: claude`

Claude Code isn't installed. See the [Claude Code install guide](https://docs.anthropic.com/en/docs/claude-code) — then come back and install the plugin.

## Plugin installed but Claude has no graph tools

1. **Restart Claude Code.** Plugins are loaded at session start; an existing session won't pick one up.
2. **Check `uv` is installed.** The plugin runs `uvx opentraceai mcp` — without `uv`, the MCP server silently fails to start. See the first entry above.
3. **Verify the plugin is listed.** Run `claude plugin list` and make sure `opentrace-oss` is present.
4. **Check plugin logs.** Look in `~/.claude/logs/` for MCP startup errors.

## `opentraceai index` hangs or fails

- **No write permissions on `.opentrace/`.** The database is written to `.opentrace/index.db` at the repo root. If the directory exists but isn't writable, indexing hangs on the first save. Fix: `chmod -R u+w .opentrace/` or delete the directory and re-index.
- **Not in a git repo.** `opentraceai` walks up from your current directory looking for the git root. If there isn't one, it falls back to the current directory — make sure that's what you want.

## Browser shows "unsupported browser"

OpenTrace needs Cross-Origin Isolation, which means:

- Chrome / Edge 91+, Firefox 119+.
- **Safari does not currently work** — see [Browser Requirements](../reference/browser-requirements.md).
- Link-preview embedded browsers (Slack, Discord, iMessage) don't support it either. Open the URL in a real browser tab.

## Port 5173 already in use (source build)

```bash
cd ui
PORT=5174 npm run dev
```

See [Configuration](configuration.md) for details.

## `make install` fails

- **Node version.** OpenTrace needs Node.js 22+. Check with `node --version`; see `ui/.nvmrc`.
- **Python version.** The agent needs Python 3.11+. Check with `python --version`.
- **Missing `uv`.** The agent install uses `uv sync`. Install `uv` as above.

## Something else

Open an issue: [github.com/opentrace/opentrace/issues](https://github.com/opentrace/opentrace/issues).

---

*Install paths: [Browser](install-browser.md) · [CLI](install-cli.md) · [Plugin](install-plugin.md) · [Source](../development/setup.md)*
