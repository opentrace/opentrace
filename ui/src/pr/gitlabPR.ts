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
 * GitLab REST API client for merge request operations.
 */

import type { PRSummary, PRDetail, PRFileDiff } from './types';

function apiBase(host: string): string {
  if (!/^[\w.-]+(:\d+)?$/.test(host))
    throw new Error(`Invalid GitLab host: ${host}`);
  return `https://${host}/api/v4`;
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h['PRIVATE-TOKEN'] = token;
  return h;
}

async function glFetch<T>(
  host: string,
  path: string,
  token?: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${apiBase(host)}${path}`, {
    ...init,
    headers: { ...headers(token), ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API error ${res.status}: ${text}`);
  }
  return res.json();
}

function mapDiffStatus(
  new_file: boolean,
  deleted_file: boolean,
  renamed_file: boolean,
): PRFileDiff['status'] {
  if (new_file) return 'added';
  if (deleted_file) return 'removed';
  if (renamed_file) return 'renamed';
  return 'modified';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMRSummary(mr: any): PRSummary {
  return {
    number: mr.iid,
    title: mr.title,
    state: mr.draft ? 'draft' : mr.state === 'opened' ? 'open' : mr.state,
    author: mr.author?.username ?? 'unknown',
    url: mr.web_url,
    created_at: mr.created_at,
    updated_at: mr.updated_at,
    base_branch: mr.target_branch ?? '',
    head_branch: mr.source_branch ?? '',
    additions: 0,
    deletions: 0,
    draft: mr.draft,
  };
}

export async function fetchGitLabMRs(
  host: string,
  projectPath: string,
  token?: string,
  state: 'opened' | 'closed' | 'merged' | 'all' = 'opened',
): Promise<PRSummary[]> {
  const encoded = encodeURIComponent(projectPath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mrs = await glFetch<any[]>(
    host,
    `/projects/${encoded}/merge_requests?state=${state}&per_page=50&order_by=updated_at`,
    token,
  );
  return mrs.map(toMRSummary);
}

export async function fetchGitLabMRDetail(
  host: string,
  projectPath: string,
  number: number,
  token?: string,
): Promise<PRDetail> {
  const encoded = encodeURIComponent(projectPath);
  const [mr, changes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    glFetch<any>(host, `/projects/${encoded}/merge_requests/${number}`, token),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    glFetch<any>(
      host,
      `/projects/${encoded}/merge_requests/${number}/changes`,
      token,
    ),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const files: PRFileDiff[] = (changes.changes ?? []).map((c: any) => ({
    path: c.new_path,
    status: mapDiffStatus(c.new_file, c.deleted_file, c.renamed_file),
    additions: 0, // GitLab doesn't provide per-file line counts in this endpoint
    deletions: 0,
    patch: c.diff,
    previous_path: c.old_path !== c.new_path ? c.old_path : undefined,
  }));

  return {
    ...toMRSummary(mr),
    body: mr.description ?? '',
    files,
    comments_count: mr.user_notes_count ?? 0,
    review_comments_count: 0,
    mergeable: mr.merge_status === 'can_be_merged',
  };
}

/**
 * Fetch a single file's content at a given git ref (branch, tag, or SHA).
 * Returns the decoded text content, or null if the file doesn't exist at that ref.
 */
export async function fetchGitLabFileContent(
  host: string,
  projectPath: string,
  path: string,
  ref: string,
  token?: string,
): Promise<string | null> {
  try {
    const encoded = encodeURIComponent(projectPath);
    const filePath = encodeURIComponent(path);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await glFetch<any>(
      host,
      `/projects/${encoded}/repository/files/${filePath}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (!data.content) return null;
    return atob(data.content);
  } catch {
    return null;
  }
}

export async function postGitLabMRComment(
  host: string,
  projectPath: string,
  number: number,
  token: string,
  body: string,
): Promise<void> {
  const encoded = encodeURIComponent(projectPath);
  await glFetch(
    host,
    `/projects/${encoded}/merge_requests/${number}/notes`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  );
}
