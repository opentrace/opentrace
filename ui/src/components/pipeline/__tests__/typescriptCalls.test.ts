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

import { describe, it, expect, beforeAll } from 'vitest';
import { runPipeline, initParsers } from '../pipeline';
import { MemoryStore } from '../store/memory';
import type { GraphRelationship, PipelineEvent } from '../types';
import { getTypeScriptParser, getTsxParser, makeRepoTree } from './helpers';

beforeAll(async () => {
  initParsers(
    new Map([
      ['typescript', await getTypeScriptParser()],
      ['tsx', await getTsxParser()],
    ]),
  );
});

/** Collect all CALLS relationships emitted while indexing `files`. */
function callEdges(files: Array<{ path: string; content: string }>) {
  const store = new MemoryStore();
  const rels: GraphRelationship[] = [];
  const events: PipelineEvent[] = [];
  for (const event of runPipeline(
    { repo: makeRepoTree(files, { owner: 'o', repo: 'r' }) },
    { cancelled: false },
    store,
  )) {
    events.push(event);
    if (event.relationships) rels.push(...event.relationships);
  }
  expect(events.some((e) => e.kind === 'done')).toBe(true);
  return rels.filter((r) => r.type === 'CALLS');
}

const FOO = `export class Foo {
  bar(): number { return 1; }
  baz(): void { this.bar(); }
}
`;

describe('TypeScript type-hint call resolution (Strategy 2.5)', () => {
  it('resolves this.method(), new-instance, param-typed, and ref.current calls to the class method', () => {
    const calls = callEdges([
      { path: 'foo.ts', content: FOO },
      {
        path: 'consumer.ts',
        content: `import { Foo } from './foo';
export function useLocal(): void {
  const f = new Foo();
  f.bar();
}
export function useParam(f: Foo): void {
  f.bar();
}
`,
      },
      {
        path: 'canvas.tsx',
        content: `import { forwardRef, useRef } from 'react';
import { Foo } from './foo';
export const Canvas = forwardRef<HTMLDivElement, object>((props, ref) => {
  const fooRef = useRef<Foo | null>(null);
  fooRef.current?.bar();
  return null;
});
`,
      },
    ]);

    // Every call above should land on Foo.bar.
    const toBar = calls.filter((c) => c.target_id.includes('::Foo::bar'));
    const from = (needle: string) =>
      toBar.some((c) => c.source_id.includes(needle));

    expect(from('::Foo::baz')).toBe(true); // Strategy 1 (this.) — control
    expect(from('::useLocal')).toBe(true); // new Foo() local
    expect(from('::useParam')).toBe(true); // param typed Foo
    expect(from('::Canvas')).toBe(true); // useRef<Foo>().current
  });

  it('does not invent edges when the receiver type is not a known class', () => {
    const calls = callEdges([
      {
        path: 'a.ts',
        content: `export function f(x: SomeInterface): void {
  x.doThing();
}
`,
      },
    ]);
    expect(calls.some((c) => c.target_id.includes('doThing'))).toBe(false);
  });

  it('resolves an object-field receiver via a unique class-method name (Strategy 8)', () => {
    // `v.canvasRef.current.zoomToFit()` — the receiver type needs cross-function
    // inference we don't do, but `zoomToFit` is a UNIQUE class method, so the
    // fallback resolves it. `get()` is shared by two classes → stays unresolved.
    const calls = callEdges([
      {
        path: 'renderer.ts',
        content: `export class Renderer {
  zoomToFit(): void {}
  get(): number { return 1; }
}
`,
      },
      {
        path: 'other.ts',
        content: `export class Other {
  get(): number { return 2; }
}
`,
      },
      {
        path: 'viewer.ts',
        content: `export function useViewer(): void {
  const v = makeThing();
  v.canvasRef.current.zoomToFit(); // unique method → resolves
  v.canvasRef.current.get();       // ambiguous (2 classes) → unresolved
}
`,
      },
    ]);
    expect(
      calls.some(
        (c) =>
          c.source_id.includes('::useViewer') &&
          c.target_id.includes('::Renderer::zoomToFit'),
      ),
    ).toBe(true);
    // `get` is defined by both Renderer and Other → not unique → no edge.
    expect(calls.some((c) => c.target_id.endsWith('::get'))).toBe(false);
  });
});
