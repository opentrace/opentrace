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

import { getCliMissingMessage } from "./util/cli-install.js"
import { findExecutable, pathWithLocalBin } from "./util/db-discovery.js"
import { debug } from "./util/debug.js"
import {
  DB_MISSING_MESSAGE,
  EXIT_DB_MISSING,
  EXIT_OK,
  EXIT_WORKSPACE_UNRESOLVABLE,
  workspaceUnresolvableMessage,
} from "./util/exit-codes.js"

/**
 * Env used when spawning the CLI. Routes through `pathWithLocalBin` so
 * probe-time (`findExecutable`) and run-time resolve under the same
 * PATH — keeping them in lockstep means a candidate that probes ok
 * cannot resolve to a different binary here.
 */
function spawnEnvWithLocalBin(): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: pathWithLocalBin(),
  }
}

export interface GraphStats {
  total_nodes: number
  total_edges: number
  nodes_by_type: Record<string, number>
  metadata?: Array<{
    repo_id: string
    commit_sha?: string
    branch?: string
    indexed_at?: string
    source_uri?: string
    node_count?: number
  }>
}

export interface GraphNode {
  id: string
  name: string
  type: string
  properties?: Record<string, any>
  score?: number
}

export interface TraversalEntry {
  node: GraphNode
  relationship?: { type: string; id: string; properties?: Record<string, any> }
  depth: number
}

export interface NodeDetail {
  node: GraphNode
  neighbors: Array<{
    node: GraphNode
    relationship: { type: string; direction: "incoming" | "outgoing" }
  }>
}

/**
 * Shape of `opentrace get-node --json`. Mirrors NodeDetail but with
 * untyped node payloads (the CLI emits store-shaped rows that need
 * `normalizeNode` before they become GraphNodes).
 */
interface GetNodePayload {
  node: any
  neighbors: Array<{
    node: any
    relationship: { type: string; direction: "incoming" | "outgoing" }
  }>
}

/**
 * Shape of `opentrace traverse --json`. The CLI envelope also carries
 * `start`/`direction`/`depth`/`relType`/`totalResults` echo fields; we
 * only consume `results`, but the CLI may add fields here without
 * breaking us.
 */
interface TraversePayload {
  results: Array<{
    node: any
    relationship: { id: string; type: string; properties?: Record<string, any> }
    depth: number
  }>
}

/**
 * Default cap on results returned from {@link GraphClient.traverse} and
 * the neighbor list returned from {@link GraphClient.getNode}. The
 * underlying CLI / `store.traverse` are unbounded — without a cap, a
 * popular symbol (e.g. a logger called from thousands of sites) would
 * balloon the LLM-visible payload of `find-usages` proportionally.
 */
const DEFAULT_TRAVERSE_LIMIT = 100

/**
 * Record emitted by `opentrace repos`. Every entry has stable keys;
 * everything except id/name is nullable because the indexer only
 * populates metadata for repos indexed via the full pipeline.
 */
export interface RepoRecord {
  id: string
  name: string
  sourceUri: string | null
  branch: string | null
  commitSha: string | null
  commitMessage: string | null
  repoPath: string | null
  indexedAt: string | null
  durationSeconds: number | null
  nodesCreated: number | null
  relationshipsCreated: number | null
  filesProcessed: number | null
  classesExtracted: number | null
  functionsExtracted: number | null
  opentraceaiVersion: string | null
}

export interface GraphClientOptions {
  timeout?: number
  /**
   * Timeout for indexing subprocesses (`index` / `fetch-and-index`).
   * Defaults to 30 min. Set to 0 to wait indefinitely — useful from
   * plugin config when a monorepo routinely blows past the default.
   */
  indexTimeout?: number
}

const DEFAULT_TIMEOUT = 10_000 // 10 seconds
// Indexing is allowed a much longer wall clock than a regular CLI call.
// When the timeout trips we kill the subprocess, which leaves staging
// files the CLI self-heals on retry — recoverable, but wasted work, so
// we'd rather err on the side of letting it finish.
const DEFAULT_INDEX_TIMEOUT = 30 * 60 * 1000 // 30 minutes
// Minimum gap between consecutive failed CLI probes. 5s feels responsive
// for a "user just installed it" turnaround while keeping subprocess
// thrash off the system-prompt rebuild path.
const ENSURE_CLI_PROBE_THROTTLE_MS = 5_000

// Max chars of CLI stderr/stdout to include in a single debug log entry.
// Keeps logs readable without losing the key of a Python traceback or native
// error message (typically 300–700 chars of meaningful content).
const STDERR_TAIL_CHARS = 800

export class GraphClient {
  /** Workspace directory passed verbatim to the CLI's `--workspace` flag. */
  private directory: string
  private exe: { cmd: string; args: string[] } | null = null
  private timeout: number
  private indexTimeout: number
  // Singleflight guard: parallel tool calls in one turn would otherwise all
  // race the same probe.
  private _ensureCliInFlight: Promise<boolean> | null = null
  // Wall-clock of the most recent ensureCli probe that returned no binary.
  // Used to throttle re-probes so the system-prompt rebuild path (run on
  // every chat turn while the CLI-missing prompt is uncached) doesn't
  // spawn `which` + `--version` subprocesses on every message.
  private _lastFailedProbeAt = 0
  /**
   * Session-level cache of "does the workspace DB exist?", populated by CLI
   * exit codes:
   *   - `null` until the first CLI invocation (or after a fresh index).
   *   - `true` once any subcommand returns exit 0.
   *   - `false` once any read subcommand returns exit 3 (`EXIT_DB_MISSING`).
   * Hooks read this synchronously via {@link dbReadyHint}; tools that gate
   * on it route through {@link requireDbAvailable}, which probes once on
   * `null` to populate it.
   */
  private _dbReady: boolean | null = null
  /**
   * Set when the CLI reports `EXIT_WORKSPACE_UNRESOLVABLE` (exit 4) — the
   * workspace directory itself can't be resolved. Treated as a hard fail
   * by every subsequent gate until the next exit-0 invocation clears it.
   * Sticky for the rest of the session: the gates short-circuit before
   * spawning the CLI, so a "fixed mid-session" cwd still requires an
   * OpenCode restart. This matches the failure mode (input.directory is
   * a fixed property of the session) — a TTL-based recovery here would
   * solve a problem we don't actually see.
   */
  private _workspaceUnresolvable: boolean = false
  /**
   * Singleflight for the cold-cache probe in {@link requireDbAvailable}.
   * Multiple tool calls in one chat turn (e.g. source-search +
   * find-usages dispatched together) would otherwise each spawn the
   * probe.
   */
  private _dbProbeInFlight: Promise<void> | null = null

  private constructor(
    directory: string,
    timeout: number,
    indexTimeout: number,
  ) {
    this.directory = directory
    this.timeout = timeout
    this.indexTimeout = indexTimeout
  }

  static async create(
    directory: string,
    options?: GraphClientOptions,
  ): Promise<GraphClient> {
    const client = new GraphClient(
      directory,
      options?.timeout ?? DEFAULT_TIMEOUT,
      options?.indexTimeout ?? DEFAULT_INDEX_TIMEOUT,
    )
    client.exe = await findExecutable()

    if (!client.exe) {
      debug("graph", "create: opentraceai CLI not available; tools will surface install guidance")
    } else {
      debug("graph", "create: workspace directory", directory)
    }

    return client
  }

  /**
   * Synchronous fast-skip predicate for hooks. Returns `false` only when
   * the workspace is known to lack a DB (or the directory itself is
   * unresolvable); both `true` and `null` mean "go ahead and invoke" —
   * the next CLI call will populate the cache. Hot path: zero subprocesses.
   */
  dbReadyHint(): boolean | null {
    if (this._workspaceUnresolvable) return false
    return this._dbReady
  }

  isCliAvailable(): boolean {
    return this.exe !== null
  }

  /**
   * Tool-entry gate for callers that need both a working CLI and an indexed
   * DB. Returns null when the client is ready to serve the call, or the
   * verbatim message the tool should return otherwise. Probes the CLI when
   * the DB-readiness cache is cold so the first tool call per session
   * surfaces the right message rather than a generic "failed".
   *
   * See {@link requireCliAvailable} for the CLI-only variant used by tools
   * (currently `opentrace_repo_index`) whose job is to create the DB.
   */
  async requireDbAvailable(): Promise<string | null> {
    const cliBlock = await this.requireCliAvailable()
    if (cliBlock) return cliBlock
    if (this._dbReady === false) return DB_MISSING_MESSAGE
    if (this._dbReady === null) {
      // Cold cache: probe once via a cheap call. Singleflighted so parallel
      // tool calls in one chat turn don't each spawn the probe.
      await this._probeDbReady()
      if (this._workspaceUnresolvable) return workspaceUnresolvableMessage(this.directory)
      if (this._dbReady === false) return DB_MISSING_MESSAGE
    }
    return null
  }

  /**
   * Spawn one `stats --output json` to populate the readiness cache.
   * Singleflighted so concurrent callers share one probe.
   */
  private async _probeDbReady(): Promise<void> {
    if (this._dbProbeInFlight) return this._dbProbeInFlight
    this._dbProbeInFlight = (async () => {
      try {
        await this.run(["stats", "--output", "json"])
      } finally {
        this._dbProbeInFlight = null
      }
    })()
    return this._dbProbeInFlight
  }

  /**
   * CLI-and-workspace tool-entry gate, for tools (currently just
   * `opentrace_repo_index`) whose job is to *create* the DB and so don't
   * require it to already exist. Verifies the CLI binary is reachable and
   * the workspace directory itself is resolvable; the latter check is what
   * keeps a broken cwd from being papered over by an "Indexing result:..."
   * success wrapper later. Every other tool should use
   * {@link requireDbAvailable} instead so a missing DB is reported as such
   * rather than silently proceeding.
   */
  async requireCliAvailable(): Promise<string | null> {
    await this.ensureCli()
    if (!this.exe) return getCliMissingMessage()
    if (this._workspaceUnresolvable) return workspaceUnresolvableMessage(this.directory)
    return null
  }

  /**
   * Pure probe. Re-runs `findExecutable` when `this.exe` is null so the
   * plugin picks up a CLI that was installed mid-session. Sets `this.exe`
   * on success. Returns whether the CLI is now available.
   *
   * Concurrency-safe via the `_ensureCliInFlight` singleflight: parallel
   * callers share one probe.
   *
   * Throttled by `_lastFailedProbeAt`: when the previous probe failed, we
   * skip re-spawning subprocesses for {@link ENSURE_CLI_PROBE_THROTTLE_MS}
   * to keep the system-prompt rebuild path off `which` and `--version`
   * once per chat turn. The next probe past the cooldown still picks up a
   * fresh install.
   */
  async ensureCli(): Promise<boolean> {
    if (this.exe) return true
    if (this._ensureCliInFlight) return this._ensureCliInFlight
    if (Date.now() - this._lastFailedProbeAt < ENSURE_CLI_PROBE_THROTTLE_MS) {
      return false
    }
    this._ensureCliInFlight = (async () => {
      try {
        const found = await findExecutable()
        if (!found) {
          this._lastFailedProbeAt = Date.now()
          return false
        }
        this.exe = found
        debug("graph", "ensureCli: opentraceai now available")
        return true
      } finally {
        this._ensureCliInFlight = null
      }
    })()
    return this._ensureCliInFlight
  }

  /**
   * Update the readiness cache from a CLI exit code. Called from both
   * `run()` and `runWithTimeout()` so every subprocess outcome feeds the
   * same state. Returns the LLM-facing message for exit 3 / 4, or null
   * for everything else; callers that surface CLI errors to the LLM
   * (`run` with `surfaceErrors: true`) substitute this in place of the
   * raw stderr passthrough so consumers see a consistent fact-stating
   * line rather than the CLI's internal message text.
   */
  private _recordExit(exitCode: number): string | null {
    if (exitCode === EXIT_OK) {
      this._dbReady = true
      this._workspaceUnresolvable = false
      return null
    }
    if (exitCode === EXIT_DB_MISSING) {
      this._dbReady = false
      return DB_MISSING_MESSAGE
    }
    if (exitCode === EXIT_WORKSPACE_UNRESOLVABLE) {
      this._workspaceUnresolvable = true
      return workspaceUnresolvableMessage(this.directory)
    }
    return null
  }

  // -------------------------------------------------------------------
  // CLI subprocess runner
  // -------------------------------------------------------------------

  private async run(
    subArgs: string[],
    opts?: { surfaceErrors?: boolean },
  ): Promise<string | null> {
    // Deadline spans probe + spawn so the user-visible budget is `this.timeout`
    // from entry, not `probe + this.timeout`. ensureCli is a no-op once
    // `this.exe` is set and self-throttles its failure path, so unconditional
    // call is cheap.
    const deadline = Date.now() + this.timeout
    await this.ensureCli()
    if (!this.exe) {
      debug("graph", "run: no executable, skipping", redactArgs(subArgs).join(" "))
      return null
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      debug("graph", "run: probe consumed full budget, skipping", subArgs[0])
      return null
    }
    // `--workspace` is a top-level flag, so it precedes the subcommand.
    const args = [...this.exe.args, "--workspace", this.directory, ...subArgs]
    try {
      const proc = Bun.spawn([this.exe.cmd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: spawnEnvWithLocalBin(),
      })

      // Read stdout and stderr BEFORE awaiting exit to avoid pipe buffer deadlock
      const stdoutPromise = new Response(proc.stdout).text()
      const stderrPromise = new Response(proc.stderr).text()
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, remaining)
      const [exitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise])
      clearTimeout(timeout)

      const semanticMessage = this._recordExit(exitCode)

      if (exitCode !== EXIT_OK) {
        const tail = (stderr.trim() || stdout.trim() || "(no output)").slice(-STDERR_TAIL_CHARS)
        debug("graph", timedOut ? "run: TIMED OUT" : `run: exit ${exitCode}`, subArgs[0], tail)
        // surfaceErrors: callers (source-search, source-grep) want a
        // user-visible reason. For the published exit-code contract
        // (3 = no DB, 4 = unresolvable) we hand back the verbatim
        // contract message; for any other non-zero we pass the CLI's
        // own stderr through so the LLM can self-correct (e.g. Click's
        // "No repo with id 'foo'. Available: a, b, c").
        if (opts?.surfaceErrors) {
          if (semanticMessage) return semanticMessage
          return stderr.trim() || stdout.trim() || `Exit code ${exitCode}`
        }
        return null
      }
      return stdout.trim() || null
    } catch (e) {
      debug("graph", "run: spawn error", subArgs[0], e)
      return null
    }
  }

  private async runJson<T>(subArgs: string[]): Promise<T | null> {
    const raw = await this.run(subArgs)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch (e) {
      // The CLI is under our control and the `--output json` /  `--json`
      // subcommands are contracted to emit one JSON document on stdout.
      // If parse fails here it's a CLI bug — surface as null and log so
      // we notice rather than papering over with a regex extraction.
      debug("graph", "runJson: not valid JSON", subArgs[0], e)
      return null
    }
  }

  // -------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------

  async stats(): Promise<GraphStats | null> {
    return this.runJson<GraphStats>(["stats", "--output", "json"])
  }

  // -------------------------------------------------------------------
  // Search (FTS)
  // -------------------------------------------------------------------

  async ftsSearch(
    query: string,
    opts?: { nodeTypes?: string[]; limit?: number },
  ): Promise<GraphNode[]> {
    const args = ["query", query, "--type", "fts", "--output", "json"]
    if (opts?.limit) args.push("--limit", String(opts.limit))
    const raw = await this.runJson<any[]>(args)
    if (!raw) return []
    return raw.map(normalizeNode)
  }

  /**
   * Render a `source-search` text block from the CLI. The CLI owns the
   * formatting (matches augment/impact patterns) so plugins don't
   * reinvent the per-result layout.
   *
   * Uses `surfaceErrors` so non-zero CLI exits (e.g. unknown `--repo`
   * id, which Click reports as "No repo with id 'foo'. Available: ...")
   * are passed through as the returned text. The LLM can then correct
   * itself on the next turn. Returns null only when the CLI executable
   * isn't resolvable.
   */
  async sourceSearchText(
    query: string,
    opts?: { repo?: string; nodeTypes?: string[]; limit?: number },
  ): Promise<string | null> {
    const args = ["source-search", query]
    if (opts?.repo) args.push("--repo", opts.repo)
    if (opts?.nodeTypes?.length) args.push("--types", opts.nodeTypes.join(","))
    if (opts?.limit) args.push("--limit", String(opts.limit))
    return this.run(args, { surfaceErrors: true })
  }

  /**
   * Render a `source-grep` text block from the CLI. Mirrors
   * `sourceSearchText` — CLI owns the formatting and the absolute-path
   * scrubbing, so the plugin doesn't reinvent ripgrep orchestration.
   *
   * `surfaceErrors` is on so an unknown `--repo` id (or any other
   * CLI-side validation failure) reaches the LLM verbatim instead of
   * collapsing to a misleading null.
   */
  async sourceGrepText(
    pattern: string,
    opts?: { repo?: string; include?: string; limit?: number },
  ): Promise<string | null> {
    const args = ["source-grep", pattern]
    if (opts?.repo) args.push("--repo", opts.repo)
    if (opts?.include) args.push("--include", opts.include)
    if (opts?.limit) args.push("--limit", String(opts.limit))
    return this.run(args, { surfaceErrors: true })
  }

  // -------------------------------------------------------------------
  // Augment
  // -------------------------------------------------------------------

  async augment(pattern: string): Promise<string | null> {
    return this.run(["augment", pattern])
  }

  // -------------------------------------------------------------------
  // Impact
  // -------------------------------------------------------------------

  async impact(filePath: string, lines?: string): Promise<string | null> {
    const args = ["impact", filePath]
    if (lines) args.push("--lines", lines)
    return this.run(args)
  }

  // -------------------------------------------------------------------
  // Node details (delegated to the CLI's `get-node` subcommand)
  // -------------------------------------------------------------------

  /**
   * Fetch a node and its 1-hop neighbors. Delegates to
   * ``opentrace get-node --json``, which composes
   * ``store.get_node(id)`` and ``store.traverse(id, both, 1)`` and
   * derives ``direction`` per neighbor. Returns ``null`` on any CLI
   * non-zero exit (node-id miss, missing DB, store error).
   *
   * Neighbors are capped at {@link DEFAULT_TRAVERSE_LIMIT} (the CLI /
   * `store.traverse` is unbounded). Truncation is logged but not
   * signaled in the return value — graph-explore, the only consumer,
   * already sub-slices to 20 per direction in its rendered output.
   */
  async getNode(nodeId: string): Promise<NodeDetail | null> {
    const payload = await this.runJson<GetNodePayload>(["get-node", nodeId, "--json"])
    if (!payload) return null

    const rawNeighbors = payload.neighbors ?? []
    if (rawNeighbors.length > DEFAULT_TRAVERSE_LIMIT) {
      debug(
        "graph",
        `getNode: capping ${rawNeighbors.length} neighbors to ${DEFAULT_TRAVERSE_LIMIT}`,
        nodeId,
      )
    }

    return {
      node: normalizeNode(payload.node),
      neighbors: rawNeighbors.slice(0, DEFAULT_TRAVERSE_LIMIT).map((n) => ({
        node: normalizeNode(n.node),
        relationship: {
          type: n.relationship.type,
          direction: n.relationship.direction,
        },
      })),
    }
  }

  // -------------------------------------------------------------------
  // Traversal (delegated to the CLI's `traverse` subcommand)
  // -------------------------------------------------------------------

  /**
   * BFS walk from a starting node. Delegates to ``opentrace traverse
   * --json``; ``depth`` on each result reflects the real per-hop
   * distance from the start node. Returns ``[]`` on any CLI non-zero
   * exit (start-node miss, missing DB, store error).
   *
   * Results are capped at ``opts.limit`` (default
   * {@link DEFAULT_TRAVERSE_LIMIT}). The CLI itself has no `--limit`
   * flag, so we slice on the TS side after parsing. This protects
   * find-usages from blowing LLM context for popular symbols (a
   * logger, a base class) referenced by thousands of sites.
   */
  async traverse(
    nodeId: string,
    direction: "incoming" | "outgoing" | "both" = "outgoing",
    depth: number = 2,
    relType?: string,
    opts?: { limit?: number },
  ): Promise<TraversalEntry[]> {
    const args = [
      "traverse",
      nodeId,
      "--direction",
      direction,
      "--depth",
      String(depth),
      "--json",
    ]
    if (relType) args.push("--rel-type", relType)

    const payload = await this.runJson<TraversePayload>(args)
    if (!payload) return []

    const limit = opts?.limit ?? DEFAULT_TRAVERSE_LIMIT
    const rawResults = payload.results ?? []
    if (rawResults.length > limit) {
      debug(
        "graph",
        `traverse: capping ${rawResults.length} results to ${limit}`,
        nodeId,
        direction,
        `depth=${depth}`,
      )
    }

    return rawResults.slice(0, limit).map((entry) => ({
      node: normalizeNode(entry.node),
      relationship: entry.relationship
        ? {
            type: entry.relationship.type,
            id: entry.relationship.id,
            properties: entry.relationship.properties,
          }
        : undefined,
      depth: entry.depth,
    }))
  }

  // -------------------------------------------------------------------
  // Source code reading (delegated to the CLI's source-read subcommand)
  // -------------------------------------------------------------------

  /**
   * Read source for a graph node or a file path, optionally sliced to a
   * line range. Delegates to the CLI's `source-read` subcommand, which
   * handles graph lookup, path resolution against indexed repo roots,
   * and file slicing with a standard `// path:start-end` header plus
   * numbered lines.
   *
   * Line-range semantics (all three supported by the CLI):
   *   - both startLine and endLine set → closed range
   *   - only startLine set            → startLine to end of file
   *   - only endLine set              → line 1 to endLine
   *   - neither set                   → whole file
   *
   * Returns null on CLI error; the calling tool should surface a
   * user-visible fallback message.
   */
  async readSource(
    opts:
      | { nodeId: string }
      | { path: string; startLine?: number; endLine?: number },
  ): Promise<string | null> {
    const args = ["source-read"]

    if ("nodeId" in opts) {
      args.push("--node-id", opts.nodeId)
      // The CLI derives the line range from the graph when given a
      // node id; it ignores --lines in that mode, so we don't pass it.
    } else {
      args.push("--path", opts.path)
      const { startLine, endLine } = opts
      if (startLine != null && endLine != null) {
        args.push("--lines", `${startLine}-${endLine}`)
      } else if (startLine != null) {
        args.push("--lines", `${startLine}-`)
      } else if (endLine != null) {
        args.push("--lines", `1-${endLine}`)
      }
    }

    return this.run(args)
  }

  // -------------------------------------------------------------------
  // Repo management (delegates to the CLI's `repos` subcommand)
  // -------------------------------------------------------------------

  /**
   * Full repository metadata from the CLI. All fields nullable except
   * id/name. `listRepos` is a shape adapter over this for LLM-visible
   * surfaces; tools that need on-disk paths route through CLI
   * subcommands (`source-grep`, `source-read`) which own clone-path
   * resolution including the rehoming convention for cloned repos.
   */
  async repos(): Promise<RepoRecord[]> {
    const records = await this.runJson<RepoRecord[]>(["repos"])
    return records ?? []
  }

  /**
   * Public repo list for LLM-visible contexts. Allowlists the fields
   * worth giving the model — branch and sourceUri shape what tools
   * apply, commitSha lets it reason about staleness. Indexer telemetry
   * (indexedAt, durationSeconds, *Created, *Extracted, opentraceaiVersion)
   * and the local repoPath are intentionally dropped: they give the LLM
   * no reasoning hook and either duplicate signals it already has from
   * graph-stats or risk misuse (the repoPath outside the sandbox, the
   * commitMessage as a privacy surface). Tools needing the full record
   * should call `repos()` directly.
   */
  async listRepos(): Promise<Array<{ id: string; name: string; properties: Record<string, any> }>> {
    const records = await this.repos()
    return records.map((r) => ({
      id: r.id,
      name: r.name,
      properties: {
        branch: r.branch,
        sourceUri: r.sourceUri,
        commitSha: r.commitSha,
      },
    }))
  }

  /**
   * Result of {@link GraphClient.indexRepo}. `ok` reflects the CLI's exit
   * status — only exit 0 is success. Callers should gate user-facing
   * "should now be searchable" assertions on `ok`; on failure, `message`
   * is the CLI's stderr/stdout (or a contract message for exit 3 / 4),
   * suitable to surface verbatim.
   */
  async indexRepo(
    pathOrUrl: string,
    repoId?: string,
    opts?: { token?: string; ref?: string },
  ): Promise<{ ok: boolean; message: string }> {
    const isUrl = /^https?:\/\//.test(pathOrUrl) || /^git@/.test(pathOrUrl)

    const args: string[] = isUrl ? ["fetch-and-index", pathOrUrl] : ["index", pathOrUrl]
    if (repoId) args.push("--repo-id", repoId)
    if (isUrl) {
      if (opts?.token) args.push("--token", opts.token)
      if (opts?.ref) args.push("--ref", opts.ref)
    }

    const result = await this.runWithTimeout(args, this.indexTimeout)
    if (result.ok) {
      return {
        ok: true,
        message: result.output || (isUrl ? "Fetch-and-index completed" : "Indexing completed"),
      }
    }
    return {
      ok: false,
      message: result.output || (isUrl ? "Fetch-and-index failed or no output" : "Indexing failed or no output"),
    }
  }

  /**
   * Result of {@link GraphClient.runWithTimeout}. `ok` is true only on
   * CLI exit 0; CLI-missing, budget-exhausted, non-zero exit, timeout,
   * and spawn errors all map to `ok: false`. `output` is the text the
   * caller should surface (stdout on success; stderr/stdout/contract
   * message on failure).
   */
  private async runWithTimeout(
    subArgs: string[],
    timeoutMs: number,
  ): Promise<{ ok: boolean; output: string }> {
    // Deadline spans probe + spawn so probe latency doesn't silently extend
    // the caller's budget. timeoutMs <= 0 means "no timeout" (used for
    // monorepo indexing) and skips the deadline entirely.
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null
    await this.ensureCli()
    if (!this.exe) {
      debug("graph", "runWithTimeout: no executable, skipping", redactArgs(subArgs).join(" "))
      return { ok: false, output: getCliMissingMessage() }
    }
    let remaining: number | null = null
    if (deadline !== null) {
      remaining = deadline - Date.now()
      if (remaining <= 0) {
        debug("graph", "runWithTimeout: probe consumed full budget, skipping", subArgs[0])
        return { ok: false, output: "CLI probe consumed the full timeout budget; nothing was run." }
      }
    }
    // `--workspace` is a top-level flag, so it precedes the subcommand.
    const args = [...this.exe.args, "--workspace", this.directory, ...subArgs]
    try {
      debug(
        "graph",
        "runWithTimeout: spawning",
        redactArgs(subArgs).join(" "),
        remaining !== null ? `(timeout ${remaining}ms)` : "(no timeout)",
      )
      const proc = Bun.spawn([this.exe.cmd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: spawnEnvWithLocalBin(),
      })
      // Read stdout/stderr BEFORE awaiting exit to avoid pipe buffer deadlock
      const stdoutPromise = new Response(proc.stdout).text()
      const stderrPromise = new Response(proc.stderr).text()
      let timedOut = false
      const killTimer = remaining !== null
        ? setTimeout(() => {
            timedOut = true
            proc.kill()
          }, remaining)
        : null
      const [exitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise])
      if (killTimer) clearTimeout(killTimer)

      const semanticMessage = this._recordExit(exitCode)

      if (exitCode !== EXIT_OK) {
        const tail = (stderr.trim() || stdout.trim() || "(no output)").slice(-STDERR_TAIL_CHARS)
        debug(
          "graph",
          timedOut ? "runWithTimeout: TIMED OUT" : `runWithTimeout: exit ${exitCode}`,
          subArgs[0],
          tail,
        )
        if (semanticMessage) return { ok: false, output: semanticMessage }
        if (timedOut) {
          return { ok: false, output: stderr.trim() || stdout.trim() || `Timed out after ${remaining}ms` }
        }
        return { ok: false, output: stderr.trim() || stdout.trim() || `Exit code ${exitCode}` }
      }
      debug("graph", "runWithTimeout: completed ok", subArgs[0])
      return { ok: true, output: stdout.trim() }
    } catch (e: any) {
      debug("graph", "runWithTimeout: spawn error", subArgs[0], e)
      return { ok: false, output: `Error: ${e.message ?? e}` }
    }
  }
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function normalizeNode(raw: any): GraphNode {
  const props = typeof raw.properties === "string"
    ? tryParseJson(raw.properties)
    : raw.properties
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    type: raw.type ?? "",
    properties: props,
    score: raw.score,
  }
}

function tryParseJson(s: string): Record<string, any> | undefined {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

// Flags whose following argument is a secret and must not appear in debug logs.
const SENSITIVE_FLAGS = new Set(["--token", "--auth", "--password", "--api-key"])

/**
 * Returns a copy of `args` with values after sensitive flags replaced by `***`.
 * Handles both the separated form (`--token <value>`) and the inline form
 * (`--token=<value>`). Used when rendering args for debug logs so PATs and
 * similar credentials don't end up on disk in ~/.opentrace/debug.log.
 */
function redactArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    // Separated form: --token <value>
    if (SENSITIVE_FLAGS.has(a) && i + 1 < args.length) {
      out.push(a, "***")
      i++
      continue
    }
    // Inline form: --token=<value>
    const eq = a.indexOf("=")
    if (eq > 0 && SENSITIVE_FLAGS.has(a.slice(0, eq))) {
      out.push(`${a.slice(0, eq)}=***`)
      continue
    }
    out.push(a)
  }
  return out
}
