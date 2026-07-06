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

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import type { PRSummary, PRDetail } from '../../pr/types';
import type { PRClient } from '../../pr/client';
import type { GraphStore } from '../../store/types';

// Stub out the heavy detail panel — these tests only care about WHICH PR
// ends up selected, not how it renders.
vi.mock('../PRDetailPanel', () => ({
  default: ({ pr }: { pr: PRDetail }) =>
    React.createElement(
      'div',
      { 'data-testid': 'pr-detail' },
      `PR ${pr.number}`,
    ),
}));
vi.mock('../../pr/indexer', () => ({ indexPRIntoGraph: vi.fn() }));

import PRListPanel from '../PRListPanel';

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function summary(number: number, title: string): PRSummary {
  return {
    number,
    title,
    author: 'octocat',
    head_branch: `feature-${number}`,
    updated_at: new Date().toISOString(),
    draft: false,
  } as PRSummary;
}

function makeClient(
  getPRDetail: (n: number) => Promise<PRDetail>,
  prs: PRSummary[] = [summary(1, 'First PR'), summary(2, 'Second PR')],
): PRClient {
  return {
    meta: { owner: 'acme', repo: 'widgets', provider: 'github' },
    listPRs: () => Promise.resolve(prs),
    getPRDetail,
  } as unknown as PRClient;
}

const store = {} as GraphStore;

describe('PRListPanel detail-request race', () => {
  it('ignores a slow earlier detail response after a newer selection', async () => {
    const d1 = deferred<PRDetail>();
    const d2 = deferred<PRDetail>();
    const getPRDetail = vi.fn((n: number) =>
      n === 1 ? d1.promise : d2.promise,
    );
    const { findByText, getByTestId, queryByText } = render(
      React.createElement(PRListPanel, {
        prClient: makeClient(getPRDetail),
        store,
      }),
    );

    // Click PR #1 (slow), then PR #2 (fast)
    fireEvent.click(await findByText('First PR'));
    fireEvent.click(await findByText('Second PR'));

    // Fast request resolves first — PR 2 is shown
    await act(async () => {
      d2.resolve({ number: 2 } as PRDetail);
    });
    expect(getByTestId('pr-detail').textContent).toBe('PR 2');

    // Slow request resolves later — must NOT clobber the newer selection
    await act(async () => {
      d1.resolve({ number: 1 } as PRDetail);
    });
    expect(getByTestId('pr-detail').textContent).toBe('PR 2');
    expect(queryByText('Loading PR details...')).toBeNull();
  });

  it('a stale rejection does not surface an error over a newer selection', async () => {
    const d1 = deferred<PRDetail>();
    const d2 = deferred<PRDetail>();
    const getPRDetail = vi.fn((n: number) =>
      n === 1 ? d1.promise : d2.promise,
    );
    const { findByText, getByTestId, queryByText } = render(
      React.createElement(PRListPanel, {
        prClient: makeClient(getPRDetail),
        store,
      }),
    );

    fireEvent.click(await findByText('First PR'));
    fireEvent.click(await findByText('Second PR'));

    await act(async () => {
      d2.resolve({ number: 2 } as PRDetail);
    });
    expect(getByTestId('pr-detail').textContent).toBe('PR 2');

    // Stale request fails — no error view, PR 2 stays selected
    await act(async () => {
      d1.reject(new Error('boom'));
    });
    expect(getByTestId('pr-detail').textContent).toBe('PR 2');
    expect(queryByText(/Failed to load PRs/)).toBeNull();
  });

  it('a slow lookup does not clobber a newer list selection', async () => {
    const d5 = deferred<PRDetail>();
    const d1 = deferred<PRDetail>();
    const getPRDetail = vi.fn((n: number) =>
      n === 5 ? d5.promise : d1.promise,
    );
    const { findByText, getByTestId, getByPlaceholderText } = render(
      React.createElement(PRListPanel, {
        prClient: makeClient(getPRDetail),
        store,
      }),
    );

    // Wait for the list to load, then start a lookup for PR #5 (slow) …
    await findByText('First PR');
    const input = getByPlaceholderText('Load PR by number or link...');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(getPRDetail).toHaveBeenCalledWith(5);

    // … then click a list item (fast)
    fireEvent.click(await findByText('First PR'));
    await act(async () => {
      d1.resolve({ number: 1 } as PRDetail);
    });
    expect(getByTestId('pr-detail').textContent).toBe('PR 1');

    // Lookup resolves late — the newer selection must win
    await act(async () => {
      d5.resolve({ number: 5 } as PRDetail);
    });
    expect(getByTestId('pr-detail').textContent).toBe('PR 1');
  });
});
