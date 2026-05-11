/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { tool } from "@opencode-ai/plugin"
import type { GraphClient } from "../graph-client.js"

export function createRepoIndexTool(
  client: GraphClient,
  resolveToken: (url?: string) => Promise<string | null>,
) {
  return tool({
    description: `Fetch and index a repository into the OpenTrace knowledge graph.
Accepts a git URL (https://github.com/org/repo) to clone and index a remote repo, or a local directory path.
After indexing, the repo's code becomes searchable and readable via all other opentrace tools.
Use this when you need to understand a dependency library or external codebase that isn't indexed yet.
Private repos are supported - authentication is handled automatically via stored credentials.
Indexing time scales with repo size and usually finishes in a few minutes; large monorepos can take longer, and the call blocks until done (or until the configured indexTimeout, default 30 minutes).`,
    args: {
      path_or_url: tool.schema.string().describe("Git URL (e.g., 'https://github.com/expressjs/express') or local directory path to index"),
      repo_id: tool.schema.string().optional().describe("Custom identifier for the repo in the graph (defaults to repo name from URL/directory)"),
      ref: tool.schema.string().optional().describe("Branch or tag to clone (defaults to repo default branch)"),
    },
    async execute(args, ctx) {
      const blocked = await client.requireCliAvailable()
      if (blocked) return blocked

      // Check if already indexed. Skip the dedup probe when we know the
      // workspace has no DB yet — the listRepos call would just hit exit 3.
      // `id` is the canonical key (matches `--repo` filters); `name` is the
      // display label and only equals `id` when the user didn't pass
      // `--repo-id` at index time. We accept either since the LLM can
      // reasonably pass either form.
      if (client.dbReadyHint() !== false) {
        const repos = await client.listRepos()
        const existing = repos.find((r) =>
          r.id === args.repo_id ||
          r.name === args.repo_id ||
          r.properties?.sourceUri === args.path_or_url,
        )
        if (existing) {
          const props = existing.properties
          return `Repository "${existing.name}" is already indexed.\n` +
            `  Source: ${props.sourceUri ?? "local"}\n` +
            `  Branch: ${props.branch ?? "unknown"}\n` +
            `  Commit: ${props.commitSha ?? "unknown"}\n\n` +
            `Use opentrace_source_search to search its code, or re-run this tool to re-index.`
        }
      }

      // Re-gate before spawning: the dedup listRepos call may have surfaced
      // an unresolvable workspace, in which case the contract message is
      // a cleaner thing to return than letting indexRepo also fail.
      const reblocked = await client.requireCliAvailable()
      if (reblocked) return reblocked

      // Strip trailing slashes so "/path/to/repo/" yields "repo".
      const name = args.path_or_url.replace(/\/+$/, "").split("/").pop()?.replace(".git", "") || "repo"
      ctx.metadata({ title: `Indexing ${name}...` })

      // Resolve token internally — picks the right token for the host
      const token = await resolveToken(args.path_or_url)

      const result = await client.indexRepo(args.path_or_url, args.repo_id, {
        token: token ?? undefined,
        ref: args.ref,
      })

      if (!result.ok) {
        if (result.inProgress) {
          ctx.metadata({ title: "Waiting on another index..." })
          return result.message
        }
        ctx.metadata({ title: `Indexing ${name} failed` })
        return `Indexing failed:\n${result.message}`
      }

      ctx.metadata({ title: `Indexed ${name}` })
      return `Indexing result:\n${result.message}\n\nThe repository should now be searchable via opentrace_source_search and readable via opentrace_source_read.`
    },
  })
}
