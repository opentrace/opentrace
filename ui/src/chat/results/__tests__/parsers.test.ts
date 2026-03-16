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

import { describe, it, expect } from 'vitest';
import {
  parseSearchResult,
  parseListNodesResult,
  parseGetNodeResult,
  parseTraverseResult,
} from '../parsers';

const validNode = { id: 'n1', type: 'Repository', name: 'AuthRepo' };
const validNode2 = { id: 'n2', type: 'Class', name: 'UsersStore' };

describe('parseSearchResult', () => {
  it('parses {results:[...]} format', () => {
    const raw = JSON.stringify({ results: [validNode, validNode2] });
    const result = parseSearchResult(raw);
    expect(result).toHaveLength(2);
    expect(result![0].name).toBe('AuthRepo');
  });

  it('parses bare array', () => {
    const raw = JSON.stringify([validNode]);
    expect(parseSearchResult(raw)).toHaveLength(1);
  });

  it('returns null on invalid JSON', () => {
    expect(parseSearchResult('not json')).toBeNull();
  });

  it('filters items missing required fields', () => {
    const raw = JSON.stringify({
      results: [validNode, { id: 'x' }, { type: 'Foo', name: 'bar' }],
    });
    const result = parseSearchResult(raw);
    expect(result).toHaveLength(1);
  });

  it('returns null for non-array data', () => {
    expect(parseSearchResult(JSON.stringify({ results: 'nope' }))).toBeNull();
  });
});

describe('parseListNodesResult', () => {
  it('parses {nodes:[...]} format', () => {
    const raw = JSON.stringify({ nodes: [validNode] });
    expect(parseListNodesResult(raw)).toHaveLength(1);
  });

  it('parses bare array', () => {
    const raw = JSON.stringify([validNode, validNode2]);
    expect(parseListNodesResult(raw)).toHaveLength(2);
  });

  it('returns null on invalid JSON', () => {
    expect(parseListNodesResult('{')).toBeNull();
  });
});

describe('parseGetNodeResult', () => {
  it('parses valid node object', () => {
    const raw = JSON.stringify(validNode);
    const result = parseGetNodeResult(raw);
    expect(result).toEqual(validNode);
  });

  it('returns null for missing required fields', () => {
    expect(parseGetNodeResult(JSON.stringify({ id: 'x' }))).toBeNull();
    expect(parseGetNodeResult(JSON.stringify({}))).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    expect(parseGetNodeResult('nope')).toBeNull();
  });
});

describe('parseTraverseResult', () => {
  it('parses {results:[{node,relationship,depth}]}', () => {
    const entry = {
      node: validNode,
      relationship: {
        id: 'r1',
        type: 'CALLS',
        source_id: 'n1',
        target_id: 'n2',
      },
      depth: 1,
    };
    const raw = JSON.stringify({ results: [entry] });
    const result = parseTraverseResult(raw);
    expect(result).toHaveLength(1);
    expect(result![0].depth).toBe(1);
  });

  it('filters invalid entries', () => {
    const raw = JSON.stringify({
      results: [
        { node: validNode, relationship: {}, depth: 0 },
        { notANode: true },
        'garbage',
      ],
    });
    const result = parseTraverseResult(raw);
    expect(result).toHaveLength(1);
  });

  it('returns null for non-array', () => {
    expect(parseTraverseResult(JSON.stringify({ results: {} }))).toBeNull();
  });
});
