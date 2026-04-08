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
import { runPipeline, collectPipeline, initParsers } from '../pipeline';
import type { PipelineContext, PipelineEvent } from '../types';
import { getPythonParser, makeRepoTree } from './helpers';

beforeAll(async () => {
  const pyParser = await getPythonParser();
  initParsers(new Map([['python', pyParser]]));
});

function noopCtx(): PipelineContext {
  return { cancelled: false };
}

describe('pipeline', () => {
  it('full pipeline on multi-file Python repo', () => {
    const repo = makeRepoTree([
      {
        path: 'src/models.py',
        content: `class User:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return f"Hello, {self.name}"
`,
      },
      {
        path: 'src/utils.py',
        content: `def helper():
    """A helper function."""
    pass

def another():
    pass
`,
      },
      { path: 'README.md', content: '# Project' },
    ]);

    const { events, nodes, relationships } = collectPipeline(
      { repo },
      noopCtx(),
    );

    const types = nodes.map((n) => n.type);
    expect(types).toContain('Repository');
    expect(types).toContain('Directory');
    expect(types).toContain('File');
    expect(types).toContain('Class');
    expect(types).toContain('Function');

    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const rel of relationships) {
      expect(nodeIds.has(rel.source_id)).toBe(true);
      expect(nodeIds.has(rel.target_id)).toBe(true);
    }

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('stage_start');
    expect(kinds).toContain('stage_progress');
    expect(kinds).toContain('stage_stop');
    expect(kinds).toContain('done');
  });

  it('stats match expectations', () => {
    const repo = makeRepoTree([
      {
        path: 'app.py',
        content: `class Handler:
    def handle(self):
        pass

def main():
    pass
`,
      },
    ]);

    const { events } = collectPipeline({ repo }, noopCtx());

    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    expect(done!.result?.filesProcessed).toBe(1);
    expect(done!.result?.classesExtracted).toBe(1);
    expect(done!.result?.functionsExtracted).toBe(2);
    expect(done!.errors).toBeUndefined();
  });

  it('cancellation between stages skips parsing', () => {
    const repo = makeRepoTree([
      { path: 'app.py', content: 'def foo():\n    pass\n' },
    ]);

    let loadingDone = false;
    const ctx: PipelineContext = {
      get cancelled() {
        return loadingDone;
      },
    };

    const events: PipelineEvent[] = [];
    for (const event of runPipeline({ repo }, ctx)) {
      events.push(event);
      if (event.kind === 'stage_stop' && event.phase === 'scanning') {
        loadingDone = true;
      }
    }

    expect(events.some((e) => e.phase === 'scanning')).toBe(true);
    // stage_start for parsing fires, but no files are actually parsed
    expect(
      events.some(
        (e) => e.kind === 'stage_progress' && e.phase === 'processing',
      ),
    ).toBe(false);
    expect(events.some((e) => e.kind === 'done')).toBe(false);
  });

  it('emits nodes on stage_stop (loading) and stage_progress (parsing)', () => {
    const repo = makeRepoTree([
      { path: 'app.py', content: 'def foo():\n    pass\n' },
    ]);

    const { events } = collectPipeline({ repo }, noopCtx());

    const loadingStop = events.find(
      (e) => e.kind === 'stage_stop' && e.phase === 'scanning',
    );
    expect(loadingStop).toBeDefined();
    expect(loadingStop!.nodes!.some((n) => n.type === 'Repository')).toBe(true);
    expect(loadingStop!.nodes!.some((n) => n.type === 'File')).toBe(true);

    const parsingProgress = events.find(
      (e) => e.kind === 'stage_progress' && e.phase === 'processing' && e.nodes,
    );
    expect(parsingProgress).toBeDefined();
    expect(parsingProgress!.nodes!.some((n) => n.type === 'Function')).toBe(
      true,
    );
  });

  it('progress events track file-by-file parsing', () => {
    const repo = makeRepoTree([
      { path: 'a.py', content: 'def a():\n    pass\n' },
      { path: 'b.py', content: 'def b():\n    pass\n' },
    ]);

    const { events } = collectPipeline({ repo }, noopCtx());

    const progressEvents = events.filter(
      (e) => e.kind === 'stage_progress' && e.phase === 'processing',
    );
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0].detail?.current).toBe(1);
    expect(progressEvents[0].detail?.total).toBe(2);
    expect(progressEvents[0].detail?.fileName).toBe('a.py');
    expect(progressEvents[1].detail?.current).toBe(2);
    expect(progressEvents[1].detail?.fileName).toBe('b.py');
  });

  it('generates summaries for functions, classes, files, and directories', () => {
    const repo = makeRepoTree([
      {
        path: 'src/models.py',
        content: `class User:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return f"Hello, {self.name}"
`,
      },
      {
        path: 'src/utils.py',
        content: `def getUserById(user_id):
    pass
`,
      },
      { path: 'README.md', content: '# Project' },
    ]);

    const { nodes } = collectPipeline({ repo }, noopCtx());

    // Functions should have summaries
    const getUserById = nodes.find(
      (n) => n.type === 'Function' && n.name === 'getUserById(user_id)',
    );
    expect(getUserById).toBeDefined();
    expect(getUserById!.properties?.summary).toBeTruthy();

    // Classes should have summaries
    const userClass = nodes.find(
      (n) => n.type === 'Class' && n.name === 'User',
    );
    expect(userClass).toBeDefined();
    expect(userClass!.properties?.summary).toBeTruthy();

    // Parseable files should have summaries (emitted as update nodes)
    const fileSummaries = nodes.filter(
      (n) => n.type === 'File' && n.properties?.summary,
    );
    expect(fileSummaries.length).toBeGreaterThanOrEqual(1);

    // Directories should have summaries
    const dirSummaries = nodes.filter(
      (n) => n.type === 'Directory' && n.properties?.summary,
    );
    expect(dirSummaries.length).toBeGreaterThanOrEqual(1);
  });

  it('loading emits per-file progress', () => {
    const repo = makeRepoTree([
      { path: 'a.py', content: '' },
      { path: 'b.py', content: '' },
      { path: 'c.txt', content: '' },
    ]);

    const { events } = collectPipeline({ repo }, noopCtx());

    const loadingProgress = events.filter(
      (e) => e.kind === 'stage_progress' && e.phase === 'scanning',
    );
    expect(loadingProgress).toHaveLength(3);
    expect(loadingProgress[0].detail?.fileName).toBe('a.py');
    expect(loadingProgress[0].detail?.current).toBe(1);
    expect(loadingProgress[0].detail?.total).toBe(3);
    expect(loadingProgress[2].detail?.fileName).toBe('c.txt');
    expect(loadingProgress[2].detail?.current).toBe(3);
  });
});
