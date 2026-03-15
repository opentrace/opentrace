/**
 * Bitbucket Cloud client for fetching repository contents.
 *
 * Downloads a zipball via the /fn/archive proxy (single request).
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

/** Parse "workspace/repo" from a Bitbucket Cloud URL. */
export function parseBitbucketUrl(
  url: string,
): { workspace: string; repo: string } | null {
  const match = url.match(/bitbucket\.org[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { workspace: match[1], repo: match[2] };
}

/** Fetch a full repo tree from Bitbucket Cloud. */
export async function fetchBitbucketRepoTree(
  workspace: string,
  repo: string,
  options: UrlLoaderOptions = {},
): Promise<RepoTree> {
  const { token, ref = 'HEAD', signal, onProgress } = options;

  const params = new URLSearchParams({
    owner: workspace,
    repo,
    ref,
    provider: 'bitbucket',
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
    owner: workspace,
    repo,
    ref,
    url: `https://bitbucket.org/${workspace}/${repo}`,
    provider: 'bitbucket',
    files,
  };
}

// ---------------------------------------------------------------------------
// RepoLoader implementation
// ---------------------------------------------------------------------------

export const bitbucketLoader: RepoLoader = {
  name: 'bitbucket',

  canHandle(input: LoaderInput): boolean {
    if (input.kind !== 'url') return false;
    const normalized = normalizeRepoUrl(input.url);
    return parseBitbucketUrl(normalized) !== null;
  },

  async load(
    input: LoaderInput,
    options: LoaderCallOptions,
  ): Promise<RepoTree> {
    if (input.kind !== 'url')
      throw new Error('Bitbucket loader requires a URL input');
    const normalized = normalizeRepoUrl(input.url);
    const parsed = parseBitbucketUrl(normalized);
    if (!parsed) throw new Error('Not a valid Bitbucket URL');
    return fetchBitbucketRepoTree(parsed.workspace, parsed.repo, {
      token: input.token,
      ref: input.ref || 'HEAD',
      signal: options.signal,
      onProgress: options.onProgress,
    });
  },
};
