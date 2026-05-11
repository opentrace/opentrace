# Contributing to OpenTrace

Thanks for your interest in contributing to OpenTrace! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/opentrace.git
   cd opentrace
   ```
3. Install dependencies:
   ```bash
   make install
   ```
4. Create a branch for your work:
   ```bash
   git checkout -b my-feature
   ```

## Development Workflow

### Running Locally

```bash
make ui    # Start dev server at http://localhost:5173
```

### Testing

```bash
make test  # Run all tests
make lint  # Run linter + format check
```

All pull requests must pass CI checks (tests, lint, formatting, license headers).

### Code Style

- **TypeScript** — Prettier for formatting, ESLint for linting
- Run `make fmt` before committing to auto-format
- License headers are required on all source files — run `make license-fix` to add them automatically

### Commit Messages

Use concise, descriptive commit messages:

- `fix: resolve duplicate node emission in pipeline`
- `feat: add summarization stage to indexing pipeline`
- `chore: update dependencies`
- `docs: add contributing guide`

## Pull Requests

1. Keep PRs focused — one feature or fix per PR
2. Include tests for new functionality
3. Update documentation if behavior changes
4. Ensure CI passes before requesting review
5. Link related issues in the PR description

## Project Structure

```
ui/                   — React/TypeScript frontend
  src/pipeline/       — Indexing pipeline (scanning → processing → resolving)
  src/runner/         — Browser-based parser workers
  src/store/          — Graph store implementations (LadybugDB WASM, in-memory)
  src/components/     — React components
  src/chat/           — Chat agent and graph tools
proto/                — Protobuf definitions
plugins/              — Editor / AI integrations
  claude-code/        — Claude Code plugin configuration
  opencode/           — OpenCode plugin (native TS, Bun runtime)
```

See `ui/src/pipeline/CLAUDE.md` for detailed pipeline architecture documentation.

## Reporting Issues

- Use [GitHub Issues](https://github.com/opentrace/opentrace/issues) for bug reports and feature requests
- Include steps to reproduce for bugs
- Check existing issues before creating a new one

## Code of Conduct

Be respectful, constructive, and inclusive. We're all here to build something useful together.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
