# Browser (No Install)

The fastest way to try OpenTrace. Everything runs in your browser — no account, no download, no server.

**[oss.opentrace.ai](https://oss.opentrace.ai)**

## How It Works

1. Open [oss.opentrace.ai](https://oss.opentrace.ai).
2. Paste a GitHub or GitLab repo URL (public repos work with no auth; private repos need a token).
3. Watch it index — tree-sitter parses every file directly in a Web Worker, and the knowledge graph is stored in an embedded LadybugDB WASM instance.
4. Explore the graph, or chat with the built-in agent.

Nothing is uploaded. Your code, the parser, and the database all live in your browser tab.

## Requirements

OpenTrace needs **Cross-Origin Isolation** (for `SharedArrayBuffer`), so you need a reasonably modern browser:

- Chrome / Edge 91+
- Firefox 119+
- Safari **does not currently work** — see [Browser Requirements](../reference/browser-requirements.md) for the WebKit limitation.

## What Next

- **Want this inside Claude Code?** → [Claude Code Plugin](install-plugin.md)
- **Want a CLI on your machine?** → [CLI](install-cli.md)
- **Hitting an unsupported-browser screen?** → [Browser Requirements](../reference/browser-requirements.md)

---

*Other install paths: [Browser](install-browser.md) · [CLI](install-cli.md) · [Plugin](install-plugin.md) · [Source](../development/setup.md)*
