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

/**
 * OpenTrace node IDs follow the pattern:
 *
 *   "repoId/path/to/file.ext::SymbolName"  — file + symbol
 *   "repoId/path/to/file.ext"              — file only
 *   "repoId"                               — repo only
 */

export interface ParsedNodeId {
  /** Repo segment. Equal to the input id if it has no "/". */
  repo: string
  /** File path relative to the repo root, or null if the id has no file segment. */
  path: string | null
  /** The "::Symbol" suffix, or null when absent. */
  symbol: string | null
}

/** Split a node id into repo / path / symbol in one pass. */
export function parseNodeId(nodeId: string): ParsedNodeId {
  const doubleColon = nodeId.indexOf("::")
  const pathPart = doubleColon !== -1 ? nodeId.substring(0, doubleColon) : nodeId
  const symbol = doubleColon !== -1 ? nodeId.substring(doubleColon + 2) : null
  const slashIdx = pathPart.indexOf("/")
  if (slashIdx === -1) {
    return { repo: pathPart, path: null, symbol }
  }
  return {
    repo: pathPart.substring(0, slashIdx),
    path: pathPart.substring(slashIdx + 1),
    symbol,
  }
}

/**
 * Extract the repo ID (the first segment before "/").
 * Returns the input verbatim if the id has no "/".
 */
export function repoFromNodeId(nodeId: string): string {
  return parseNodeId(nodeId).repo
}

/**
 * Extract the repo-relative file path from a node id, stripping any
 * "::Symbol" suffix. Returns null if the id has no file segment.
 */
export function filePathFromNodeId(nodeId: string): string | null {
  return parseNodeId(nodeId).path
}
