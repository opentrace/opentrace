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
import { describe, expect, it } from 'vitest';

import { mergeAddNodesCommunities } from '../forceLayout3dWorker';

describe('mergeAddNodesCommunities', () => {
  it('merges a FULL record copy-on-write (old spread-merge semantics)', () => {
    const current = { a: 1, b: 2 };
    const merged = mergeAddNodesCommunities(current, { b: 5, c: 3 }, undefined);
    expect(merged).toEqual({ a: 1, b: 5, c: 3 });
    // Copy-on-write: forces holding the old object are unaffected until the
    // sim rebuild installs the merged one.
    expect(merged).not.toBe(current);
    expect(current).toEqual({ a: 1, b: 2 });
  });

  it('merges a DELTA in place (new-node ids only — no per-batch clone)', () => {
    const current = { a: 1 };
    const merged = mergeAddNodesCommunities(current, undefined, { b: 2 });
    expect(merged).toBe(current);
    expect(merged).toEqual({ a: 1, b: 2 });
  });

  it('creates a record from a delta when none exists yet', () => {
    const delta = { a: 1 };
    const merged = mergeAddNodesCommunities(undefined, undefined, delta);
    expect(merged).toEqual({ a: 1 });
    expect(merged).not.toBe(delta); // worker owns its copy
  });

  it('returns current unchanged when the message carries neither', () => {
    const current = { a: 1 };
    expect(mergeAddNodesCommunities(current, undefined, undefined)).toBe(
      current,
    );
    expect(
      mergeAddNodesCommunities(undefined, undefined, undefined),
    ).toBeUndefined();
  });

  it('end state matches the old always-send-full protocol across a stream', () => {
    // Old protocol: every add-nodes carried the full assignments record.
    // New protocol: full at init / on Louvain identity change, deltas for the
    // new node ids otherwise. Simulate a stream and compare end states.
    const initialAssignments = { a: 0, b: 0 };
    const afterLouvain = { a: 0, b: 0, c: 1, d: 1, e: 2 };

    // OLD: init full, per-batch full (stale until Louvain), full on change.
    let oldState: Record<string, number> | undefined;
    oldState = mergeAddNodesCommunities(
      oldState,
      initialAssignments,
      undefined,
    );
    oldState = mergeAddNodesCommunities(
      oldState,
      initialAssignments,
      undefined,
    );
    oldState = mergeAddNodesCommunities(
      oldState,
      initialAssignments,
      undefined,
    );
    oldState = mergeAddNodesCommunities(oldState, afterLouvain, undefined);

    // NEW: init full, per-batch delta of new ids (stale assignments → empty
    // deltas), full on change.
    let newState: Record<string, number> | undefined;
    newState = mergeAddNodesCommunities(
      newState,
      initialAssignments,
      undefined,
    );
    newState = mergeAddNodesCommunities(newState, undefined, {});
    newState = mergeAddNodesCommunities(newState, undefined, {});
    newState = mergeAddNodesCommunities(newState, afterLouvain, undefined);

    expect(newState).toEqual(oldState);
  });
});
