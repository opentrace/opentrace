/**
 * RepoLoader interface — the Strategy abstraction for fetching code.
 *
 * Each concrete loader (GitHub, GitLab, local directory) implements
 * `canHandle` for detection and `load` for fetching. The manager
 * iterates a registry array and delegates to the first match.
 */

import type { FetchProgress } from "./shared";
import type { RepoTree } from "../types";

// --- Loader input discriminated union ---

export type LoaderInput =
  | { kind: "url"; url: string; token?: string; ref?: string }
  | { kind: "directory"; files: FileList; name: string };

// --- Callback options passed to every loader ---

export interface LoaderCallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FetchProgress) => void;
}

// --- The loader interface ---

export interface RepoLoader {
  /** Human-readable name for diagnostics. */
  name: string;
  /** Return true if this loader can handle the given input. */
  canHandle(input: LoaderInput): boolean;
  /** Fetch / read files and return a RepoTree. */
  load(input: LoaderInput, options: LoaderCallOptions): Promise<RepoTree>;
}
