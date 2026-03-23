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
 * GitHub REST API client for pull request operations.
 */

import type { PRSummary, PRDetail, PRFileDiff, PRReviewComment } from './types';

const API = 'https://api.github.com';

/**
 * Parse a unified diff patch to extract valid RIGHT-side line numbers.
 * GitHub review comments require `line` to be a line visible in the diff.
 */
function parsePatchLines(patch: string): Set<number> {
  const validLines = new Set<number>();
  let rightLine = 0;

  for (const line of patch.split('\n')) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      rightLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (line.startsWith('-')) {
      // Deletion — only on LEFT side, doesn't advance right line counter
      continue;
    }
    if (line.startsWith('+') || line.startsWith(' ')) {
      validLines.add(rightLine);
      rightLine++;
    }
  }
  return validLines;
}

/**
 * Find the closest valid line in the diff to a given target line.
 * Returns undefined if no valid lines exist.
 */
function snapToValidLine(
  target: number,
  validLines: Set<number>,
): number | undefined {
  if (validLines.has(target)) return target;

  let closest: number | undefined;
  let minDist = Infinity;
  for (const line of validLines) {
    const dist = Math.abs(line - target);
    if (dist < minDist) {
      minDist = dist;
      closest = line;
    }
  }
  return closest;
}

/** Return the first (lowest) line number in the set, or undefined. */
function firstValidLine(validLines: Set<number>): number | undefined {
  let min: number | undefined;
  for (const line of validLines) {
    if (min === undefined || line < min) min = line;
  }
  return min;
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghFetch<T>(
  path: string,
  token?: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers(token), ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return res.json();
}

function mapFileStatus(status: string): PRFileDiff['status'] {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPRSummary(pr: any): PRSummary {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.draft ? 'draft' : pr.state,
    author: pr.user?.login ?? 'unknown',
    url: pr.html_url,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    base_branch: pr.base?.ref ?? '',
    head_branch: pr.head?.ref ?? '',
    draft: pr.draft,
  };
}

export async function fetchGitHubPRs(
  owner: string,
  repo: string,
  token?: string,
  state: 'open' | 'closed' | 'all' = 'open',
): Promise<PRSummary[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prs = await ghFetch<any[]>(
    `/repos/${owner}/${repo}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`,
    token,
  );
  return prs.map(toPRSummary);
}

export async function fetchGitHubPRDetail(
  owner: string,
  repo: string,
  number: number,
  token?: string,
): Promise<PRDetail> {
  const [pr, files] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ghFetch<any>(`/repos/${owner}/${repo}/pulls/${number}`, token),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ghFetch<any[]>(
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
      token,
    ),
  ]);

  return {
    ...toPRSummary(pr),
    body: pr.body ?? '',
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    comments_count: pr.comments ?? 0,
    review_comments_count: pr.review_comments ?? 0,
    mergeable: pr.mergeable ?? undefined,
    files: files.map((f) => ({
      path: f.filename,
      status: mapFileStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
      previous_path: f.previous_filename,
    })),
  };
}

export async function createGitHubReview(
  owner: string,
  repo: string,
  number: number,
  token: string,
  body: string,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT',
  comments?: PRReviewComment[],
  /** Pass PR file diffs so we can validate comment line numbers against the patch */
  fileDiffs?: PRFileDiff[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = { body, event };
  if (comments?.length) {
    // Build a map of file path → valid diff lines
    const patchLinesByPath = new Map<string, Set<number>>();
    if (fileDiffs) {
      for (const f of fileDiffs) {
        if (f.patch) {
          patchLinesByPath.set(f.path, parsePatchLines(f.patch));
        }
      }
    }

    // GitHub's reviews endpoint requires a valid `line` on every comment.
    // Resolve each comment to a line visible in the diff; drop comments
    // whose file has no patch data (binary files, etc.).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved: any[] = [];

    for (const c of comments) {
      const validLines = c.path ? patchLinesByPath.get(c.path) : undefined;
      if (!validLines?.size) continue; // no patch for this file — skip

      if (c.line && validLines.has(c.line)) {
        // Exact match — use it directly
        resolved.push({
          body: c.body,
          path: c.path,
          line: c.line,
          side: c.side ?? 'RIGHT',
        });
      } else if (c.line) {
        // Snap to closest visible diff line
        const snapped = snapToValidLine(c.line, validLines);
        if (snapped !== undefined) {
          resolved.push({
            body: `(re: line ${c.line}) ${c.body}`,
            path: c.path,
            line: snapped,
            side: c.side ?? 'RIGHT',
          });
        }
      } else {
        // No line provided — pin to first line of the file's diff
        const first = firstValidLine(validLines);
        if (first !== undefined) {
          resolved.push({
            body: c.body,
            path: c.path,
            line: first,
            side: 'RIGHT',
          });
        }
      }
    }

    if (resolved.length) {
      payload.comments = resolved;
    }
  }
  await ghFetch(`/repos/${owner}/${repo}/pulls/${number}/reviews`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Fetch a single file's content at a given git ref (branch, tag, or SHA).
 * Returns the decoded text content, or null if the file doesn't exist at that ref.
 */
export async function fetchGitHubFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token?: string,
): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await ghFetch<any>(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (data.type !== 'file' || !data.content) return null;
    return atob(data.content.replace(/\n/g, ''));
  } catch {
    return null;
  }
}

export async function postGitHubPRComment(
  owner: string,
  repo: string,
  number: number,
  token: string,
  body: string,
): Promise<void> {
  await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}
