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
 * Azure DevOps client for fetching repository contents.
 *
 * Downloads a zipball via the /fn/archive proxy (single request).
 * Supports three URL formats:
 *  - dev.azure.com/{org}/{project}/_git/{repo}
 *  - {org}.visualstudio.com/{project}/_git/{repo}
 *  - vs-ssh.visualstudio.com/v3/{org}/{project}/{repo} (SSH, after normalization)
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

export interface AzureDevOpsParsed {
  org: string;
  project: string;
  repo: string;
  host: string;
}

/** Parse org/project/repo from an Azure DevOps URL. */
export function parseAzureDevOpsUrl(url: string): AzureDevOpsParsed | null {
  // Format 1a: dev.azure.com/{org}/{project}/_git/{repo} (full, with separate project)
  const devFullMatch = url.match(
    /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/.?#]+)/,
  );
  if (devFullMatch) {
    return {
      org: devFullMatch[1],
      project: devFullMatch[2],
      repo: devFullMatch[3],
      host: 'dev.azure.com',
    };
  }

  // Format 1b: dev.azure.com/{org}/_git/{repo} (short, project = repo)
  const devShortMatch = url.match(/dev\.azure\.com\/([^/]+)\/_git\/([^/.?#]+)/);
  if (devShortMatch) {
    return {
      org: devShortMatch[1],
      project: devShortMatch[2],
      repo: devShortMatch[2],
      host: 'dev.azure.com',
    };
  }

  // Format 2a: {org}.visualstudio.com/{project}/_git/{repo} (full)
  const vsFullMatch = url.match(
    /([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/.?#]+)/,
  );
  if (vsFullMatch) {
    return {
      org: vsFullMatch[1],
      project: vsFullMatch[2],
      repo: vsFullMatch[3],
      host: 'dev.azure.com',
    };
  }

  // Format 2b: {org}.visualstudio.com/_git/{repo} (short, project = repo)
  const vsShortMatch = url.match(
    /([^/.]+)\.visualstudio\.com\/_git\/([^/.?#]+)/,
  );
  if (vsShortMatch) {
    return {
      org: vsShortMatch[1],
      project: vsShortMatch[2],
      repo: vsShortMatch[2],
      host: 'dev.azure.com',
    };
  }

  // Format 3: vs-ssh.visualstudio.com/v3/{org}/{project}/{repo}
  const sshMatch = url.match(
    /vs-ssh\.visualstudio\.com\/v3\/([^/]+)\/([^/]+)\/([^/.?#]+)/,
  );
  if (sshMatch) {
    return {
      org: sshMatch[1],
      project: sshMatch[2],
      repo: sshMatch[3],
      host: 'dev.azure.com',
    };
  }

  return null;
}

/** Fetch a full repo tree from Azure DevOps. */
export async function fetchAzureDevOpsRepoTree(
  parsed: AzureDevOpsParsed,
  options: UrlLoaderOptions = {},
): Promise<RepoTree> {
  // Azure DevOps doesn't resolve "HEAD" — default to "main"
  const { token, ref = 'main', signal, onProgress } = options;

  const params = new URLSearchParams({
    owner: `${parsed.org}/${parsed.project}`,
    repo: parsed.repo,
    ref,
    provider: 'azure',
    mode: 'resolve',
  });
  const base = import.meta.env.VITE_ARCHIVE_URL || '/fn/archive';
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
    owner: `${parsed.org}/${parsed.project}`,
    repo: parsed.repo,
    ref,
    url: `https://dev.azure.com/${parsed.org}/${parsed.project}/_git/${parsed.repo}`,
    provider: 'azuredevops',
    files,
  };
}

// ---------------------------------------------------------------------------
// RepoLoader implementation
// ---------------------------------------------------------------------------

export const azuredevopsLoader: RepoLoader = {
  name: 'azuredevops',

  canHandle(input: LoaderInput): boolean {
    if (input.kind !== 'url') return false;
    const normalized = normalizeRepoUrl(input.url);
    return parseAzureDevOpsUrl(normalized) !== null;
  },

  async load(
    input: LoaderInput,
    options: LoaderCallOptions,
  ): Promise<RepoTree> {
    if (input.kind !== 'url')
      throw new Error('Azure DevOps loader requires a URL input');
    const normalized = normalizeRepoUrl(input.url);
    const parsed = parseAzureDevOpsUrl(normalized);
    if (!parsed) throw new Error('Not a valid Azure DevOps URL');
    return fetchAzureDevOpsRepoTree(parsed, {
      token: input.token,
      ref: input.ref || 'main',
      signal: options.signal,
      onProgress: options.onProgress,
    });
  },
};
