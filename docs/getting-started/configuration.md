# Configuration

## UI Development Server

The UI dev server runs on `localhost:5173` by default. To use a different port:

```bash
PORT=5174 npm run dev
```

Uses `strictPort: true` so Vite will error if the port is already taken.

## Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` to configure your instance.

## Claude Code Plugin

OpenTrace ships a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that connects Claude to an OpenTrace MCP server. See `plugins/claude-code/` for configuration details.
