/**
 * GitHub REST API client for fetching repository contents.
 *
 * Downloads a zipball via the /fn/archive proxy (single request).
 */

import { unzipSync } from 'fflate';
import { extractFilesFromZip, type UrlLoaderOptions } from './shared';
import type {
  RepoLoader,
  LoaderInput,
  LoaderCallOptions,
} from './loaderInterface';
import { normalizeRepoUrl } from './urlNormalize';
import type { RepoTree } from '../types';

/** Parse "owner/repo" from a GitHub URL. */
export function parseGitHubUrl(
  url: string,
): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** Fetch a full repo tree. Uses zipball by default. */
export async function fetchRepoTree(
  owner: string,
  repo: string,
  options: UrlLoaderOptions = {},
): Promise<RepoTree> {
  return fetchViaZipball(owner, repo, options);
}

// ---------------------------------------------------------------------------
// Zipball mode (via /fn/archive proxy)
// ---------------------------------------------------------------------------

async function fetchViaZipball(
  owner: string,
  repo: string,
  options: UrlLoaderOptions,
): Promise<RepoTree> {
  const { token, ref = 'HEAD', signal, onProgress } = options;

  onProgress?.({ phase: 'tree', current: 0, total: 1 });

  const params = new URLSearchParams({ owner, repo, ref, provider: 'github' });
  const base = import.meta.env.VITE_ARCHIVE_URL || '/fn/archive';
  const zipUrl = `${base}?${params}`;
  const fetchHeaders: Record<string, string> = {};
  if (token) {
    fetchHeaders.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(zipUrl, { headers: fetchHeaders, signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub archive fetch error ${res.status}: ${text}`);
  }

  onProgress?.({ phase: 'tree', current: 1, total: 1 });

  // Read the zip into a buffer and decompress
  const zipBuffer = new Uint8Array(await res.arrayBuffer());
  const entries = unzipSync(zipBuffer);

  const files = extractFilesFromZip(entries, onProgress);

  return {
    owner,
    repo,
    ref,
    url: `https://github.com/${owner}/${repo}`,
    provider: 'github',
    files,
  };
}

// ---------------------------------------------------------------------------
// RepoLoader implementation
// ---------------------------------------------------------------------------

export const githubLoader: RepoLoader = {
  name: 'github',

  canHandle(input: LoaderInput): boolean {
    if (input.kind !== 'url') return false;
    const normalized = normalizeRepoUrl(input.url);
    return parseGitHubUrl(normalized) !== null;
  },

  async load(
    input: LoaderInput,
    options: LoaderCallOptions,
  ): Promise<RepoTree> {
    if (input.kind !== 'url')
      throw new Error('GitHub loader requires a URL input');
    const normalized = normalizeRepoUrl(input.url);
    const parsed = parseGitHubUrl(normalized);
    if (!parsed) throw new Error('Not a valid GitHub URL');
    return fetchRepoTree(parsed.owner, parsed.repo, {
      token: input.token,
      ref: input.ref || 'HEAD',
      signal: options.signal,
      onProgress: options.onProgress,
    });
  },
};
