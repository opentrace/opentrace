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
 * Azure DevOps REST API client for pull request operations.
 *
 * Auth uses Personal Access Token (PAT) via Basic auth: base64(:{PAT}).
 * All requests append ?api-version=7.0.
 */

import type { PRSummary, PRDetail, PRFileDiff } from './types';

function apiBase(org: string, project: string, repo: string): string {
  return `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}`;
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Basic ${btoa(`:${token}`)}`;
  return h;
}

async function adoFetch<T>(
  url: string,
  token?: string,
  init?: RequestInit,
): Promise<T> {
  const separator = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${separator}api-version=7.0`;
  const res = await fetch(fullUrl, {
    ...init,
    headers: { ...headers(token), ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure DevOps API error ${res.status}: ${text}`);
  }
  return res.json();
}

function mapChangeType(changeType: number | string): PRFileDiff['status'] {
  // Azure DevOps uses numeric change types: 1=add, 2=edit, 16=rename, 32=delete
  const ct =
    typeof changeType === 'string' ? changeType.toLowerCase() : changeType;
  if (ct === 1 || ct === 'add') return 'added';
  if (ct === 32 || ct === 'delete') return 'removed';
  if (ct === 16 || ct === 'rename') return 'renamed';
  return 'modified';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPRSummary(pr: any): PRSummary {
  const refPrefix = 'refs/heads/';
  const targetRef = pr.targetRefName ?? '';
  const sourceRef = pr.sourceRefName ?? '';
  return {
    number: pr.pullRequestId,
    title: pr.title,
    state: pr.isDraft ? 'draft' : pr.status === 'active' ? 'open' : pr.status,
    author: pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? 'unknown',
    url: pr._links?.web?.href ?? '',
    created_at: pr.creationDate,
    updated_at: pr.closedDate ?? pr.creationDate,
    base_branch: targetRef.startsWith(refPrefix)
      ? targetRef.slice(refPrefix.length)
      : targetRef,
    head_branch: sourceRef.startsWith(refPrefix)
      ? sourceRef.slice(refPrefix.length)
      : sourceRef,
    draft: pr.isDraft,
  };
}

/** Split "org/project" owner string into its parts. */
function parseOwner(owner: string): { org: string; project: string } {
  const idx = owner.indexOf('/');
  if (idx < 0) throw new Error(`Invalid Azure DevOps owner format: ${owner}`);
  return { org: owner.slice(0, idx), project: owner.slice(idx + 1) };
}

export async function fetchAzureDevOpsPRs(
  owner: string,
  repo: string,
  token?: string,
): Promise<PRSummary[]> {
  const { org, project } = parseOwner(owner);
  const base = apiBase(org, project, repo);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await adoFetch<any>(
    `${base}/pullrequests?searchCriteria.status=active&$top=50`,
    token,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.value ?? []).map((pr: any) => toPRSummary(pr));
}

export async function fetchAzureDevOpsPRDetail(
  owner: string,
  repo: string,
  number: number,
  token?: string,
): Promise<PRDetail> {
  const { org, project } = parseOwner(owner);
  const base = apiBase(org, project, repo);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pr = await adoFetch<any>(`${base}/pullrequests/${number}`, token);

  // Get iterations to find changes
  let files: PRFileDiff[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const iterations = await adoFetch<any>(
      `${base}/pullrequests/${number}/iterations`,
      token,
    );
    const iterationCount = iterations.value?.length ?? 0;
    if (iterationCount > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const changes = await adoFetch<any>(
        `${base}/pullrequests/${number}/iterations/${iterationCount}/changes`,
        token,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      files = (changes.changeEntries ?? []).map((c: any) => ({
        path: c.item?.path ?? '',
        status: mapChangeType(c.changeType),
        additions: 0,
        deletions: 0,
        previous_path: c.sourceServerItem,
      }));
    }
  } catch {
    // iterations endpoint may fail — return PR without file details
  }

  return {
    ...toPRSummary(pr),
    body: pr.description ?? '',
    additions: 0,
    deletions: 0,
    files,
    comments_count: 0,
    review_comments_count: 0,
    mergeable: pr.mergeStatus === 'succeeded' ? true : undefined,
  };
}

export async function fetchAzureDevOpsFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token?: string,
): Promise<string | null> {
  try {
    const { org, project } = parseOwner(owner);
    const base = apiBase(org, project, repo);
    const url = `${base}/items?path=${encodeURIComponent(path)}&versionDescriptor.version=${encodeURIComponent(ref)}&versionDescriptor.versionType=branch`;
    const separator = url.includes('?') ? '&' : '?';
    const fullUrl = `${url}${separator}api-version=7.0`;
    const res = await fetch(fullUrl, { headers: headers(token) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function postAzureDevOpsPRComment(
  owner: string,
  repo: string,
  number: number,
  token: string,
  body: string,
): Promise<void> {
  const { org, project } = parseOwner(owner);
  const base = apiBase(org, project, repo);
  await adoFetch(`${base}/pullrequests/${number}/threads`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      comments: [{ content: body, commentType: 1 }],
      status: 1,
    }),
  });
}
