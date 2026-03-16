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
 * Bitbucket Cloud REST API client for pull request operations.
 */

import type { PRSummary, PRDetail, PRFileDiff } from './types';

const API = 'https://api.bitbucket.org/2.0/repositories';

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function bbFetch<T>(
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
    throw new Error(`Bitbucket API error ${res.status}: ${text}`);
  }
  return res.json();
}

function mapDiffstatStatus(status: string): PRFileDiff['status'] {
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
    number: pr.id,
    title: pr.title,
    state: pr.state === 'OPEN' ? 'open' : pr.state.toLowerCase(),
    author: pr.author?.display_name ?? pr.author?.nickname ?? 'unknown',
    url: pr.links?.html?.href ?? '',
    created_at: pr.created_on,
    updated_at: pr.updated_on,
    base_branch: pr.destination?.branch?.name ?? '',
    head_branch: pr.source?.branch?.name ?? '',
    additions: 0,
    deletions: 0,
  };
}

export async function fetchBitbucketPRs(
  workspace: string,
  repo: string,
  token?: string,
): Promise<PRSummary[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await bbFetch<any>(
    `/${workspace}/${repo}/pullrequests?state=OPEN&pagelen=50`,
    token,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.values ?? []).map((pr: any) => toPRSummary(pr));
}

export async function fetchBitbucketPRDetail(
  workspace: string,
  repo: string,
  number: number,
  token?: string,
): Promise<PRDetail> {
  const [pr, diffstat] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bbFetch<any>(`/${workspace}/${repo}/pullrequests/${number}`, token),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bbFetch<any>(
      `/${workspace}/${repo}/pullrequests/${number}/diffstat`,
      token,
    ),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const files: PRFileDiff[] = (diffstat.values ?? []).map((d: any) => ({
    path: d.new?.path ?? d.old?.path ?? '',
    status: mapDiffstatStatus(d.status),
    additions: d.lines_added ?? 0,
    deletions: d.lines_removed ?? 0,
    previous_path: d.old?.path !== d.new?.path ? d.old?.path : undefined,
  }));

  return {
    ...toPRSummary(pr),
    body: pr.description ?? '',
    files,
    comments_count: pr.comment_count ?? 0,
    review_comments_count: 0,
    mergeable: undefined,
  };
}

export async function fetchBitbucketFileContent(
  workspace: string,
  repo: string,
  path: string,
  ref: string,
  token?: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${API}/${workspace}/${repo}/src/${encodeURIComponent(ref)}/${path}`,
      { headers: headers(token) },
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function postBitbucketPRComment(
  workspace: string,
  repo: string,
  number: number,
  token: string,
  body: string,
): Promise<void> {
  await bbFetch(
    `/${workspace}/${repo}/pullrequests/${number}/comments`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { raw: body } }),
    },
  );
}
