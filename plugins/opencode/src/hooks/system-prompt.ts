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

import type { GraphClient } from "../graph-client.js"
import { debug } from "../util/debug.js"

/**
 * Result of {@link buildSystemPrompt}. `hasAppendix` is the cache key
 * the caller uses: caching the static-only `text` would mask a
 * mid-session state transition (CLI install, indexing finishes) until
 * the cache TTL expired, so callers should only cache when this is true.
 */
export interface SystemPromptResult {
  text: string
  hasAppendix: boolean
}

/**
 * Builds the system prompt injection that tells the LLM about OpenTrace
 * capabilities.
 *
 * The prompt is split into two parts:
 *   - A static core (always emitted) that frames the opentrace_ tools as
 *     the preferred path for code-structure questions and lists what each
 *     tool is for.
 *   - A dynamic appendix (emitted only when CLI + DB + stats are all
 *     reachable) listing graph stats and indexed repositories with their
 *     canonical `--repo` filter ids.
 *
 * State-specific guidance — install the CLI, wait for indexing, run
 * opentrace_repo_index — is intentionally NOT in this prompt. Those
 * messages live on the tool gates (`requireCliAvailable` /
 * `requireDbAvailable` in graph-client.ts) and surface only when the LLM
 * actually invokes a tool that needs that capability. The prompt's job
 * is to teach the LLM what's available; the gate's job is to report the
 * current state on demand.
 */
export async function buildSystemPrompt(client: GraphClient): Promise<SystemPromptResult> {
  // Re-probe in case the CLI was installed mid-session. ensureCli is a
  // no-op once `this.exe` is set and self-throttles its failure path,
  // so unconditional call is cheap.
  await client.ensureCli()

  const lines: string[] = [
    "# OpenTrace Knowledge Graph - USE THESE TOOLS FIRST",
    "",
    "IMPORTANT: You have OpenTrace tools available for code intelligence. When answering questions about code structure, finding symbols, understanding dependencies, or reading source from indexed repositories - use the opentrace_ tools first before falling back to grep/glob/read.",
    "",
    "## How to use opentrace tools",
    "Use opentrace tools to search and read code stored in the OpenTrace knowledge graph.",
    "When opentrace tools return results (search hits, node IDs, file paths), follow up with opentrace_source_read to read the code - it can access all indexed repos directly.",
    "Use your regular tools (read, grep, glob) for files in the current project directory as normal.",
    "Opentrace tools are available to all agents including explore and general subagents.",
    "",
    "## Tool selection guide",
    "- Find code by keyword across indexed repos → opentrace_source_search",
    "- Find code by meaning/description → opentrace_semantic_search",
    "- Read source code from an indexed repo → opentrace_source_read (pass a node_id or file path)",
    "- Regex pattern search across indexed repos → opentrace_source_grep",
    "- Find callers/usages of a symbol → opentrace_find_usages",
    "- Blast radius analysis → opentrace_impact_analysis",
    "- Explore node relationships → opentrace_graph_explore",
    "- Index a new repo → opentrace_repo_index",
    "- Overview of what's indexed → opentrace_graph_stats",
  ]

  // Dynamic appendix: only meaningful when CLI + DB + stats all resolve.
  // On any failure the static core stands alone — the tool gates surface
  // the specific reason (CLI missing / indexing / no DB) on first call.
  let hasAppendix = false
  if (client.isCliAvailable() && client.dbReadyHint() !== false) {
    const stats = await client.stats()
    if (stats) {
      hasAppendix = true
      lines.push("", "## Current state", `The graph contains ${stats.total_nodes} nodes and ${stats.total_edges} edges.`)

      if (stats.nodes_by_type) {
        const top = Object.entries(stats.nodes_by_type)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([type, count]) => `${count} ${type}`)
          .join(", ")
        lines.push(`Indexed: ${top}.`)
      }

      const repos = await client.listRepos()
      if (repos.length) {
        lines.push("", "Indexed repositories (use the id with opentrace_source_search --repo):")
        for (const repo of repos) {
          const props = repo.properties
          const parts = [`- ${repo.id}`]
          if (repo.name && repo.name !== repo.id) parts.push(`(${repo.name})`)
          if (props.branch) parts.push(`[${props.branch}]`)
          lines.push(parts.join(" "))
        }
      }
    } else {
      debug("hook.system", "appendix omitted: stats call returned null")
    }
  }

  return { text: lines.join("\n"), hasAppendix }
}
