/**
 * Shared types and helpers for repo loaders.
 *
 * Extracted from github.ts / gitlab.ts to eliminate duplication.
 * Both zipball and tree-API loaders use these for filtering, zip
 * extraction, and bounded-concurrency fetching.
 */

import { EXCLUDED_DIRS, IMAGE_EXTENSIONS, MAX_FILE_SIZE } from './constants';
import type { RepoFile } from '../types';

// --- Progress reporting ---

export interface FetchProgress {
  phase: 'tree' | 'blobs';
  current: number;
  total: number;
  fileName?: string;
}

// --- Fetch options for URL-based loaders (GitHub / GitLab) ---

export interface UrlLoaderOptions {
  token?: string;
  ref?: string;
  signal?: AbortSignal;
  onProgress?: (progress: FetchProgress) => void;
}

// --- Shared constants ---

/** Max concurrent blob fetches to avoid rate-limiting / socket exhaustion. */
export const BLOB_CONCURRENCY = 10;

// --- Shared helpers ---

/** Check if any directory segment in a path is in the exclusion set. */
export function isExcludedDir(parts: string[]): boolean {
  for (let i = 0; i < parts.length - 1; i++) {
    if (EXCLUDED_DIRS.has(parts[i])) return true;
  }
  return false;
}

/** Detect the top-level prefix directory inside a zip archive. */
export function detectZipPrefix(entries: Record<string, Uint8Array>): string {
  const firstPath = Object.keys(entries)[0];
  if (!firstPath) return '';
  const slashIdx = firstPath.indexOf('/');
  return slashIdx >= 0 ? firstPath.slice(0, slashIdx + 1) : '';
}

/**
 * Convert a Uint8Array to a base64 string.
 * Processes in chunks to avoid call-stack overflow with large arrays.
 */
function uint8ToBase64(data: Uint8Array): string {
  const CHUNK = 0x8000; // 32 KiB — safe for String.fromCharCode.apply
  let binary = '';
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      data.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}

/**
 * Extract RepoFile entries from unzipped archive entries.
 *
 * Strips the top-level prefix directory (e.g. "owner-repo-sha/"),
 * filters out excluded dirs and oversized files, and decodes content.
 * Image files are base64-encoded and flagged as binary.
 */
export function extractFilesFromZip(
  entries: Record<string, Uint8Array>,
  onProgress?: (progress: FetchProgress) => void,
): RepoFile[] {
  const prefix = detectZipPrefix(entries);
  const allPaths = Object.keys(entries);
  const files: RepoFile[] = [];

  for (const fullPath of allPaths) {
    const relPath = prefix ? fullPath.slice(prefix.length) : fullPath;
    if (!relPath || relPath.endsWith('/')) continue;

    const raw = entries[fullPath];
    if (raw.length > MAX_FILE_SIZE) continue;

    const parts = relPath.split('/');
    if (isExcludedDir(parts)) continue;

    const dotIdx = relPath.lastIndexOf('.');
    const ext = dotIdx >= 0 ? relPath.slice(dotIdx).toLowerCase() : '';
    const isImage = IMAGE_EXTENSIONS.has(ext) && ext !== '.svg';

    if (isImage) {
      files.push({
        path: relPath,
        content: uint8ToBase64(raw),
        sha: '',
        size: raw.length,
        binary: true,
      });
    } else {
      files.push({
        path: relPath,
        content: new TextDecoder().decode(raw),
        sha: '',
        size: raw.length,
      });
    }

    onProgress?.({
      phase: 'blobs',
      current: files.length,
      total: allPaths.length,
      fileName: relPath,
    });
  }

  return files;
}

/**
 * Run an async function over items with bounded concurrency.
 *
 * At most `concurrency` invocations of `fn` execute in parallel.
 * Resolves when all items have been processed.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const active: Promise<void>[] = [];

  while (queue.length > 0 || active.length > 0) {
    while (active.length < concurrency && queue.length > 0) {
      const item = queue.shift()!;
      const p = fn(item).then(() => {
        active.splice(active.indexOf(p), 1);
      });
      active.push(p);
    }
    if (active.length > 0) {
      await Promise.race(active);
    }
  }
}
