/**
 * Shared types and helpers for repo loaders.
 *
 * Extracted from github.ts / gitlab.ts to eliminate duplication.
 * Both zipball and tree-API loaders use these for filtering, zip
 * extraction, and bounded-concurrency fetching.
 */

import {
  BINARY_EXTENSIONS,
  EXCLUDED_DIRS,
  IMAGE_EXTENSIONS,
  MAX_FILE_SIZE,
} from './constants';
import type { RepoFile } from '../types';

// --- Progress reporting ---

export interface FetchProgress {
  phase: 'tree' | 'download' | 'blobs';
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
 * Detect binary content by scanning for null bytes in the first 8 KiB.
 * This is the same heuristic git uses for binary detection.
 */
export function isBinaryData(data: Uint8Array): boolean {
  const limit = Math.min(data.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (data[i] === 0) return true;
  }
  return false;
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
  const eligibleTotal = allPaths.filter((p) => !p.endsWith('/')).length;
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
    } else if (BINARY_EXTENSIONS.has(ext) || isBinaryData(raw)) {
      // Skip non-image binary files — they can't be parsed or displayed
      continue;
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
      total: eligibleTotal,
      fileName: relPath,
    });
  }

  return files;
}

/** Response from the archive resolve endpoint. */
interface ResolveResult {
  url: string;
  contentLength: number;
}

/**
 * Two-step archive fetch: resolve the download URL, then stream the zip
 * with progress reporting based on the known content length.
 */
export async function fetchResolvedArchive(
  resolveUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  onProgress?: (progress: FetchProgress) => void,
): Promise<Uint8Array> {
  // Step 1: resolve → { url, contentLength }
  const resolveRes = await fetch(resolveUrl, { headers, signal });
  if (!resolveRes.ok) {
    const text = await resolveRes.text();
    throw new Error(`Archive resolve error ${resolveRes.status}: ${text}`);
  }
  const { url, contentLength } = (await resolveRes.json()) as ResolveResult;

  // Step 2: fetch the actual zip, streaming for progress
  const zipRes = await fetch(url, { headers, signal });
  if (!zipRes.ok) {
    const text = await zipRes.text();
    throw new Error(`Archive download error ${zipRes.status}: ${text}`);
  }

  const total = contentLength || 0;

  // If no ReadableStream body (unlikely in modern browsers), fall back
  if (!zipRes.body) {
    const buf = new Uint8Array(await zipRes.arrayBuffer());
    onProgress?.({ phase: 'download', current: buf.length, total: buf.length });
    return buf;
  }

  // Stream with progress
  const reader = zipRes.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ phase: 'download', current: received, total });
  }

  // Concatenate chunks
  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
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
      const p: Promise<void> = fn(item).then(() => {
        const idx = active.indexOf(p);
        if (idx >= 0) active.splice(idx, 1);
      });
      active.push(p);
    }
    if (active.length > 0) {
      await Promise.race(active);
    }
  }
}
