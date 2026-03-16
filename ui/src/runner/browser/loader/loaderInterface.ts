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
 * RepoLoader interface — the Strategy abstraction for fetching code.
 *
 * Each concrete loader (GitHub, GitLab, local directory) implements
 * `canHandle` for detection and `load` for fetching. The manager
 * iterates a registry array and delegates to the first match.
 */

import type { FetchProgress } from './shared';
import type { RepoTree } from '../types';

// --- Loader input discriminated union ---

export type LoaderInput =
  | { kind: 'url'; url: string; token?: string; ref?: string }
  | { kind: 'directory'; files: FileList; name: string };

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
