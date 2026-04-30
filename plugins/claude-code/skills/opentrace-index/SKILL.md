---
name: opentrace-index
description: |
  PREFERRED tool for indexing (or re-indexing) a project — local directory
  or remote git URL — into the OpenTrace knowledge graph. Use this BEFORE
  shell-based exploration of an unfamiliar repo: indexing once unlocks
  every other OpenTrace skill and MCP tool, which dramatically reduces the
  number of file reads and shell searches needed for downstream questions.
  Use the `repo_index` MCP tool (not shell `uvx opentraceai index`) — it
  hot-reloads the server. Trigger phrases: "index this repo", "fetch and
  index X", "re-index", "update the graph", "build the index", "opentrace
  index", "rebuild opentrace", "refresh the graph".
allowed-tools: mcp__opentrace_oss__repo_index, mcp__opentrace_oss__get_stats, Bash
---

Index a project into the OpenTrace knowledge graph.

1. **Identify the target**:
   - If the user gave a **git URL** (`https://github.com/...`,
     `https://gitlab.com/...`, `git@host:org/repo.git`), use it as-is.
   - If they said "this repo" or gave nothing, default to the repository
     root via `git rev-parse --show-toplevel`.
   - Otherwise use the path they specified.

2. **Call `repo_index`**: pass the URL or absolute path as
   `path_or_url`. Optional: `repoId` to override the inferred name,
   `ref` to clone a specific branch/tag.
   - URLs are cloned to `~/.opentrace/repos/{org}/{name}/` (kept on
     disk so `source_read` can serve files later) and indexed.
   - Local paths are indexed in place.
   - The server hot-reloads after the subprocess exits.

3. **Public repos only**: the open-source build clones over plain HTTPS
   without authentication. If a clone fails with a 403/401, the repo is
   private — tell the user that private-repo indexing is part of the
   paid OpenTrace product, not the OSS build.

4. **Shell fallback** (rare): only when the user wants flags the MCP
   tool doesn't expose (e.g. `--batch-size`). Otherwise stick with
   `repo_index`.

5. **Report**: After indexing finishes, summarize what was added. On
   failure, show the trimmed stderr and suggest fixes (missing `uv`,
   wrong path, private repo).

6. **Verify**: Call `get_stats` (or run the `opentrace-graph-status`
   skill) so the user can confirm the new repo appears.

Prerequisites the user should have:
- `uv` installed (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- Write permission for the target directory and `~/.opentrace/`
- Public read access to any remote URL passed to `repo_index`
