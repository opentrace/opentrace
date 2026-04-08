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
import { parseFile, initParsers } from '../stages/parsing';
import { collectPipeline } from '../pipeline';
import type { PipelineContext } from '../types';
import { getPythonParser, makeRepoTree } from './helpers';

function noopCtx(): PipelineContext {
  return { cancelled: false };
}

beforeAll(async () => {
  const pyParser = await getPythonParser();
  initParsers(new Map([['python', pyParser]]));
});

function runBoth(files: Array<{ path: string; content: string }>) {
  const repo = makeRepoTree(files);
  return collectPipeline({ repo }, noopCtx());
}

describe('parsing stage', () => {
  it('extracts top-level function', () => {
    const { nodes, relationships } = runBoth([
      { path: 'app.py', content: 'def hello():\n    pass\n' },
    ]);

    const funcNode = nodes.find(
      (n) => n.type === 'Function' && n.name === 'hello()',
    );
    expect(funcNode).toBeDefined();
    expect(funcNode!.id).toBe('testorg/testrepo/app.py::hello()');

    const rel = relationships.find((r) => r.target_id === funcNode!.id);
    expect(rel?.source_id).toBe('testorg/testrepo/app.py');
    expect(rel?.type).toBe('DEFINES');
  });

  it('extracts class', () => {
    const { nodes, relationships } = runBoth([
      { path: 'models.py', content: 'class User:\n    pass\n' },
    ]);

    const classNode = nodes.find(
      (n) => n.type === 'Class' && n.name === 'User',
    );
    expect(classNode).toBeDefined();
    expect(classNode!.id).toBe('testorg/testrepo/models.py::User');

    const rel = relationships.find((r) => r.target_id === classNode!.id);
    expect(rel?.source_id).toBe('testorg/testrepo/models.py');
  });

  it('extracts class methods', () => {
    const src = `class Dog:
    def bark(self):
        pass
    def fetch(self, item):
        pass
`;
    const { nodes, relationships } = runBoth([
      { path: 'animals.py', content: src },
    ]);

    const bark = nodes.find(
      (n) => n.name === 'bark(self)' && n.type === 'Function',
    );
    expect(bark).toBeDefined();
    expect(bark!.id).toBe('testorg/testrepo/animals.py::Dog::bark()');

    const barkRel = relationships.find((r) => r.target_id === bark!.id);
    expect(barkRel?.source_id).toBe('testorg/testrepo/animals.py::Dog');

    const fetch = nodes.find(
      (n) => n.name === 'fetch(self, item)' && n.type === 'Function',
    );
    expect(fetch).toBeDefined();
  });

  it('preserves line numbers', () => {
    const src = `# comment
def foo():
    pass

def bar():
    x = 1
    return x
`;
    const { nodes } = runBoth([{ path: 'lib.py', content: src }]);

    const foo = nodes.find((n) => n.name === 'foo()');
    expect(foo?.properties?.startLine).toBe(2);
    expect(foo?.properties?.endLine).toBe(3);

    const bar = nodes.find((n) => n.name === 'bar()');
    expect(bar?.properties?.startLine).toBe(5);
    expect(bar?.properties?.endLine).toBe(7);
  });

  it('captures signature', () => {
    const { nodes } = runBoth([
      { path: 'a.py', content: 'def greet(name, greeting="hi"):\n    pass\n' },
    ]);

    const func = nodes.find((n) => n.name === 'greet(name, greeting="hi")');
    expect(func?.properties?.signature).toBe('(name, greeting="hi")');
  });

  it('captures docstring', () => {
    const src = `def documented():
    """This function is documented."""
    pass
`;
    const { nodes } = runBoth([{ path: 'doc.py', content: src }]);

    const func = nodes.find((n) => n.name === 'documented()');
    expect(func?.properties?.docs).toBe('This function is documented.');
  });

  it('aggregates loading + parsing nodes', () => {
    const src = `class Service:
    def run(self):
        pass

def main():
    pass
`;
    const { nodes } = runBoth([{ path: 'src/app.py', content: src }]);

    const types = new Set(nodes.map((n) => n.type));
    expect(types).toContain('Repository');
    expect(types).toContain('Directory');
    expect(types).toContain('File');
    expect(types).toContain('Class');
    expect(types).toContain('Function');
  });

  it('stats are accurate', () => {
    const { events } = runBoth([
      {
        path: 'stats.py',
        content: `class A:
    def m1(self):
        pass
    def m2(self):
        pass

def standalone():
    pass
`,
      },
    ]);

    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    expect(done!.result?.filesProcessed).toBe(1);
    expect(done!.result?.classesExtracted).toBe(1);
    expect(done!.result?.functionsExtracted).toBe(3);
    expect(done!.errors).toBeUndefined();
  });

  it('handles parse error gracefully', () => {
    const { nodes, events } = runBoth([
      { path: 'good.py', content: 'def ok():\n    pass\n' },
      { path: 'bad.py', content: 'def (\n' },
    ]);

    const okFunc = nodes.find((n) => n.name === 'ok()');
    expect(okFunc).toBeDefined();

    const done = events.find((e) => e.kind === 'done');
    expect(done!.result?.filesProcessed).toBe(2);
  });

  it('skips non-Python files', () => {
    const result = parseFile('notes.txt', 'hello world', 'testorg/testrepo');
    expect(result.nodes).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });
});
