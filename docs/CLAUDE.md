# Docs

Public documentation site built with MkDocs Material, deployed to GitHub Pages at `opentrace.github.io/opentrace`.

## Build & Serve

```bash
pip install mkdocs-material   # or uv pip install
mkdocs serve                  # Local preview at http://127.0.0.1:8000
mkdocs build                  # Static site → site/
```

CI handles deployment — don't run `mkdocs gh-deploy` manually.

## Structure

```
index.md               — Home page
getting-started/       — Per-audience install guides (browser, CLI, plugin)
architecture/          — System overview
development/           — Contributor setup, contributing guide
reference/             — Languages, chat providers, graph tools, browser requirements
assets/                — Logo, favicon
stylesheets/extra.css  — Custom colors overriding Material theme palette
```

Navigation is defined in `../mkdocs.yml` (`nav:` key). Adding a new page means:
1. Create the `.md` file in the appropriate section directory
2. Add it to the `nav:` section in `mkdocs.yml`

## Conventions

- **Admonitions** (`!!! note`, `!!! warning`) are enabled — use them for callouts
- **Tabbed content** (`=== "Tab 1"`) for showing alternatives (pip vs uv, Mac vs Linux)
- **Code copy buttons** are on by default — no annotation needed
- **Edit links** point to `edit/main/docs/<path>` — makes "Edit this page" work on GitHub

## Pitfalls

- **`site_url` is hardcoded** to the GitHub Pages path. `mkdocs serve` works locally but links may render differently in dev vs production — always test with both.
- **Custom colors** in `extra.css` override the Material palette. If you change the theme `palette` in `mkdocs.yml`, check that `extra.css` doesn't fight it.
- **No API reference generation.** All docs are hand-written Markdown. If the agent or UI grows a generated API reference, it would need a new MkDocs plugin.
