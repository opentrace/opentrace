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
 * GitLab REST API client for fetching repository contents.
 *
 * Downloads an archive via the /fn/archive proxy (single request).
 * Supports both gitlab.com and self-hosted instances.
 */

import { unzipSync } from 'fflate';
import {
  extractFilesFromZip,
  fetchResolvedArchive,
  type UrlLoaderOptions,
} from './shared';
import type {
  RepoLoader,
  LoaderInput,
  LoaderCallOptions,
} from './loaderInterface';
import { normalizeRepoUrl } from './urlNormalize';
import type { RepoTree } from '../types';

export interface GitLabParsed {
  host: string;
  /** URL-encoded full project path (e.g. "group%2Fsubgroup%2Fproject") */
  projectPath: string;
  /** Human-readable namespace (e.g. "group/subgroup") */
  namespace: string;
  /** Project name (last path segment) */
  project: string;
}

/** Parse host + project path from a GitLab URL. Supports subgroups. */
export function parseGitLabUrl(url: string): GitLabParsed | null {
  // Match: gitlab.example.com/group[/subgroup...]/project
  // Also handles URLs with protocol, .git suffix, and trailing slashes
  const match = url.match(
    /(?:https?:\/\/)?([^/]*gitlab[^/]*)\/([\w.-]+(?:\/[\w.-]+)+)\/?/,
  );
  if (!match) return null;

  const host = match[1];
  const fullPath = match[2].replace(/\.git$/, '');
  const segments = fullPath.split('/');

  if (segments.length < 2) return null;

  const project = segments[segments.length - 1];
  const namespace = segments.slice(0, -1).join('/');

  return {
    host,
    projectPath: encodeURIComponent(fullPath),
    namespace,
    project,
  };
}

/** Fetch a full repo tree from GitLab. */
export async function fetchGitLabRepoTree(
  parsed: GitLabParsed,
  options: UrlLoaderOptions = {},
): Promise<RepoTree> {
  return fetchGitLabViaZipball(parsed, options);
}

// ---------------------------------------------------------------------------
// Zipball mode (via /fn/archive proxy)
// ---------------------------------------------------------------------------

async function fetchGitLabViaZipball(
  parsed: GitLabParsed,
  options: UrlLoaderOptions,
): Promise<RepoTree> {
  const { token, ref = 'HEAD', signal, onProgress } = options;

  const params = new URLSearchParams({
    provider: 'gitlab',
    owner: parsed.namespace,
    repo: parsed.project,
    ref,
    host: parsed.host,
    mode: 'resolve',
  });
  const base = import.meta.env.VITE_ARCHIVE_URL || 'https://oss.opentrace.ai/fn/archive';
  const resolveUrl = `${base}?${params}`;
  const fetchHeaders: Record<string, string> = {};
  if (token) {
    fetchHeaders.Authorization = `Bearer ${token}`;
  }

  const zipBuffer = await fetchResolvedArchive(
    resolveUrl,
    fetchHeaders,
    signal,
    onProgress,
  );
  const entries = unzipSync(zipBuffer);

  const files = extractFilesFromZip(entries, onProgress);

  return {
    owner: parsed.namespace,
    repo: parsed.project,
    ref,
    url: `https://${parsed.host}/${parsed.namespace}/${parsed.project}`,
    provider: 'gitlab',
    files,
  };
}

// ---------------------------------------------------------------------------
// RepoLoader implementation
// ---------------------------------------------------------------------------

export const gitlabLoader: RepoLoader = {
  name: 'gitlab',

  canHandle(input: LoaderInput): boolean {
    if (input.kind !== 'url') return false;
    const normalized = normalizeRepoUrl(input.url);
    return parseGitLabUrl(normalized) !== null;
  },

  async load(
    input: LoaderInput,
    options: LoaderCallOptions,
  ): Promise<RepoTree> {
    if (input.kind !== 'url')
      throw new Error('GitLab loader requires a URL input');
    const normalized = normalizeRepoUrl(input.url);
    const parsed = parseGitLabUrl(normalized);
    if (!parsed) throw new Error('Not a valid GitLab URL');
    return fetchGitLabRepoTree(parsed, {
      token: input.token,
      ref: input.ref || 'HEAD',
      signal: options.signal,
      onProgress: options.onProgress,
    });
  },
};
