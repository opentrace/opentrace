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

import type { Plugin, Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { z } from "zod"
import { GraphClient } from "./graph-client.js"
import { createSourceSearchTool } from "./tools/source-search.js"
import { createSemanticSearchTool } from "./tools/semantic-search.js"
import { createSourceReadTool } from "./tools/source-read.js"
import { createSourceGrepTool } from "./tools/source-grep.js"
import { createRepoIndexTool } from "./tools/repo-index.js"
import { createFindUsagesTool } from "./tools/find-usages.js"
import { createImpactAnalysisTool } from "./tools/impact-analysis.js"
import { createGraphExploreTool } from "./tools/graph-explore.js"
import { createGraphStatsTool } from "./tools/graph-stats.js"
import { buildSystemPrompt } from "./hooks/system-prompt.js"
import { createToolAugmentHook } from "./hooks/tool-augment.js"
import { createToolImpactHook } from "./hooks/tool-impact.js"
import { createAuthHook, getStoredToken } from "./auth.js"
import { configureDebug, debug } from "./util/debug.js"

export const OpentracePluginOptionsSchema = z
  .object({
    /** Timeout for CLI calls in ms (default: 10000) */
    timeout: z.number().int().positive().optional(),
    /**
     * Timeout for `index` / `fetch-and-index` invocations in ms
     * (default: 1_800_000 = 30 min). Indexing a large repo can take
     * much longer than a regular CLI call; when the limit trips the
     * indexer is killed mid-run, leaving staging files the CLI will
     * self-heal on the next attempt. Set to 0 to wait indefinitely —
     * `GraphClient.runWithTimeout` treats `<= 0` as no-timeout.
     */
    indexTimeout: z.number().int().nonnegative().optional(),
    /** Enable debug logging to ~/.opentrace/debug.log (default: false) */
    debug: z.boolean().optional(),
    /** Override the debug log file path (default: ~/.opentrace/debug.log) */
    debugFile: z.string().min(1).optional(),
  })
  .strict()

export type OpentracePluginOptions = z.infer<typeof OpentracePluginOptionsSchema>

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * Resolve the best git token for *url*.
 *
 * Sources, in priority order:
 *   1. The OpenCode-managed credential from the plugin's AuthHook.
 *      Used only when *url* resolves to a known git host
 *      (github.com / gitlab.com). The keychain stores one token at a
 *      time and doesn't record which provider it came from, so
 *      unknown hosts fall through to the env-var path to avoid
 *      cross-host leak.
 *   2. The matching host-specific env var (GITHUB_TOKEN / GITLAB_TOKEN).
 *   3. OPENTRACE_GIT_TOKEN as an explicit cross-host override for
 *      self-hosted GitHub Enterprise, GitLab, Gitea, etc.
 *
 * Returns null if no token is available. CI-style `fetch-and-index`
 * runs without any stored auth still work for public repos — the
 * CLI just doesn't receive a `--token` flag.
 */
async function resolveToken(url?: string): Promise<string | null> {
  const hostname = url ? extractHostname(url) : null
  const token = await getStoredToken(hostname)
  // Only log when we actually tried to match a host — "no token for a
  // local path" isn't useful; the auth plumbing only does anything when
  // there's a hostname to match against, and local-path indexing ignores
  // the returned token anyway (indexRepo skips --token for non-URLs).
  if (!token && hostname) {
    debug("auth", "resolveToken: no token for", hostname)
  }
  return token
}

const server: Plugin = async (
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> => {
  const parseResult = OpentracePluginOptionsSchema.safeParse(options ?? {})
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
    throw new Error(`OpenTrace plugin: invalid options — ${issues}`)
  }
  const opts = parseResult.data
  configureDebug({ debug: opts.debug, debugFile: opts.debugFile })

  // Initialize the graph client
  const client = await GraphClient.create(input.directory, {
    timeout: opts.timeout,
    indexTimeout: opts.indexTimeout,
  })

  // System prompt cache — avoid re-running stats on every message
  let cachedSystemPrompt: string | null = null
  let cachedSystemPromptTime = 0

  const authHook = createAuthHook()

  return {
    // ---------------------------------------------------------------
    // Auth: secure PAT storage via OpenCode's auth system
    // ---------------------------------------------------------------
    auth: authHook,

    // ---------------------------------------------------------------
    // Register 9 native tools
    // ---------------------------------------------------------------
    tool: {
      "opentrace_source_search": createSourceSearchTool(client),
      "opentrace_semantic_search": createSemanticSearchTool(client),
      "opentrace_source_read": createSourceReadTool(client),
      "opentrace_source_grep": createSourceGrepTool(client),
      "opentrace_repo_index": createRepoIndexTool(client, resolveToken),
      "opentrace_find_usages": createFindUsagesTool(client),
      "opentrace_impact_analysis": createImpactAnalysisTool(client),
      "opentrace_graph_explore": createGraphExploreTool(client),
      "opentrace_graph_stats": createGraphStatsTool(client),
    },

    // ---------------------------------------------------------------
    // System prompt: inject graph awareness into every LLM call
    // Cached + 3s timeout so it never blocks the UI
    // ---------------------------------------------------------------
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        // Use cached prompt if available (refreshes every 60s)
        const now = Date.now()
        if (cachedSystemPrompt && now - cachedSystemPromptTime < 60_000) {
          output.system.push(cachedSystemPrompt)
          return
        }

        // Race the prompt build against a 3s timeout. The prompt itself
        // always returns a result — the static core has no failure
        // modes; the timeout protects against a hung stats() / listRepos()
        // inside the dynamic appendix block.
        const TIMEOUT = Symbol("system-prompt-timeout")
        const result = await Promise.race([
          buildSystemPrompt(client),
          new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), 3000)),
        ])

        if (result === TIMEOUT) {
          debug("hook.system", "buildSystemPrompt timed out (3s)")
          return
        }

        // Cache only when the dynamic appendix actually rendered. If we
        // cached the static-only prompt (because stats() returned null
        // transiently, or because CLI/DB weren't ready yet), a mid-session
        // state transition would be hidden behind the cache TTL until it
        // expired.
        if (result.hasAppendix) {
          cachedSystemPrompt = result.text
          cachedSystemPromptTime = now
        }
        output.system.push(result.text)
      } catch (e) {
        debug("hook.system", "buildSystemPrompt threw", e)
      }
    },

    // ---------------------------------------------------------------
    // Tool hooks: augment search + impact analysis
    //
    // Both run after the tool produces its output. They filter by tool
    // name (grep/glob for augment, edit/write for impact), so in the
    // common case only one fires per call, but they're dispatched
    // sequentially here so any future overlap has deterministic order.
    // ---------------------------------------------------------------
    "tool.execute.after": (() => {
      const augment = createToolAugmentHook(client)
      const impact = createToolImpactHook(client)
      return async (input, output) => {
        await augment(input, output)
        await impact(input, output)
      }
    })(),
  }
}

export default { id: "opentrace", server }
