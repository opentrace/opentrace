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

import type { RepoMeta } from './types';

const KEY_PREFIX = 'ot_pr_review:';

export interface SavedReview {
  /** Raw review output (markdown + ```json:review block). */
  result: string;
  /** Epoch ms when the review was submitted to the PR host. Absent if never submitted. */
  submittedAt?: number;
}

function key(meta: Pick<RepoMeta, 'provider' | 'owner' | 'repo'>, n: number) {
  return `${KEY_PREFIX}${meta.provider}:${meta.owner}:${meta.repo}:${n}`;
}

export function loadReview(
  meta: Pick<RepoMeta, 'provider' | 'owner' | 'repo'>,
  number: number,
): SavedReview | null {
  const raw = localStorage.getItem(key(meta, number));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SavedReview;
    if (typeof parsed?.result !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveReview(
  meta: Pick<RepoMeta, 'provider' | 'owner' | 'repo'>,
  number: number,
  review: SavedReview,
): void {
  try {
    localStorage.setItem(key(meta, number), JSON.stringify(review));
  } catch {
    /* quota — drop silently */
  }
}

export function clearReview(
  meta: Pick<RepoMeta, 'provider' | 'owner' | 'repo'>,
  number: number,
): void {
  localStorage.removeItem(key(meta, number));
}
