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
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import React from 'react';
import { JobPhase } from '../../gen/opentrace/v1/agent_service';
import type { JobState } from '../../job';
import LiveIndexingPanel from '../LiveIndexingPanel';

afterEach(cleanup);

function jobState(overrides: Partial<JobState> = {}): JobState {
  return {
    status: 'running',
    phase: JobPhase.JOB_PHASE_UNSPECIFIED,
    message: '',
    detail: {
      current: 0,
      total: 0,
      fileName: '',
      nodesCreated: 0,
      relationshipsCreated: 0,
    },
    nodesCreated: 42,
    relationshipsCreated: 7,
    result: null,
    error: null,
    stages: {},
    ...overrides,
  };
}

describe('LiveIndexingPanel', () => {
  it('minimizes instead of cancelling — no cancel control, minimize fires onMinimize', () => {
    const onMinimize = vi.fn();
    const onExpand = vi.fn();
    render(
      React.createElement(LiveIndexingPanel, {
        state: jobState(),
        stages: [],
        onExpand,
        onMinimize,
      }),
    );

    // The destructive "Cancel indexing" affordance is gone from the panel.
    expect(screen.queryByLabelText('Cancel indexing')).toBeNull();

    const minimize = screen.getByLabelText('Minimize indexing panel');
    fireEvent.click(minimize);
    expect(onMinimize).toHaveBeenCalledOnce();
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('still exposes the expand affordance', () => {
    const onExpand = vi.fn();
    render(
      React.createElement(LiveIndexingPanel, {
        state: jobState(),
        stages: [],
        onExpand,
        onMinimize: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByLabelText('Expand indexing details'));
    expect(onExpand).toHaveBeenCalledOnce();
  });
});
