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
import { execute } from '../stages/scanning';
import { getExtension, parentDir, detectLanguage } from '../stages/loading';
import type { ScanResult, PipelineContext, PipelineEvent } from '../types';
import { makeRepoTree } from './helpers';

function noopCtx(): PipelineContext {
  return { cancelled: false };
}

/** Drain the loading generator, collecting events and the final return value. */
function runScanning(...args: Parameters<typeof execute>): {
  result: ScanResult;
  events: PipelineEvent[];
} {
  const gen = execute(...args);
  const events: PipelineEvent[] = [];
  let step = gen.next();
  while (!step.done) {
    events.push(step.value);
    step = gen.next();
  }
  return { result: step.value, events };
}

describe('scanning stage', () => {
  it('creates Repository node', () => {
    const repo = makeRepoTree([]);
    const { result } = runScanning({ repo }, noopCtx());
    expect(result.repoNode.id).toBe('testorg/testrepo');
    expect(result.repoNode.type).toBe('Repository');
    expect(result.repoNode.name).toBe('testorg/testrepo');
    expect(result.repoId).toBe('testorg/testrepo');
  });

  it('creates File nodes for all files', () => {
    const repo = makeRepoTree([
      { path: 'main.py' },
      { path: 'src/utils.py' },
      { path: 'README.md' },
    ]);
    const { result } = runScanning({ repo }, noopCtx());
    expect(result.fileNodes).toHaveLength(3);

    const mainFile = result.fileNodes.find(
      (n) => n.id === 'testorg/testrepo/main.py',
    );
    expect(mainFile).toBeDefined();
    expect(mainFile!.type).toBe('File');
    expect(mainFile!.properties?.path).toBe('main.py');
    expect(mainFile!.properties?.extension).toBe('.py');
  });

  it('creates Directory hierarchy', () => {
    const repo = makeRepoTree([{ path: 'src/utils/helper.py' }]);
    const { result } = runScanning({ repo }, noopCtx());

    expect(result.dirNodes.has('src')).toBe(true);
    expect(result.dirNodes.has('src/utils')).toBe(true);
    expect(result.dirNodes.get('src')!.name).toBe('src');
    expect(result.dirNodes.get('src/utils')!.name).toBe('utils');

    // Check DEFINES chain: src/utils -> src -> repo
    const utilsRel = result.structureRels.find(
      (r) =>
        r.source_id === 'testorg/testrepo/src/utils' && r.type === 'DEFINES',
    );
    expect(utilsRel?.target_id).toBe('testorg/testrepo/src');

    const srcRel = result.structureRels.find(
      (r) => r.source_id === 'testorg/testrepo/src' && r.type === 'DEFINES',
    );
    expect(srcRel?.target_id).toBe('testorg/testrepo');
  });

  it('root files link to Repository', () => {
    const repo = makeRepoTree([{ path: 'setup.py' }]);
    const { result } = runScanning({ repo }, noopCtx());

    const rel = result.structureRels.find(
      (r) => r.source_id === 'testorg/testrepo/setup.py',
    );
    expect(rel?.target_id).toBe('testorg/testrepo');
  });

  it('root dirs link to Repository', () => {
    const repo = makeRepoTree([{ path: 'lib/code.py' }]);
    const { result } = runScanning({ repo }, noopCtx());

    const rel = result.structureRels.find(
      (r) => r.source_id === 'testorg/testrepo/lib' && r.type === 'DEFINES',
    );
    expect(rel?.target_id).toBe('testorg/testrepo');
  });

  it('identifies parseable files', () => {
    const repo = makeRepoTree([
      { path: 'app.py' },
      { path: 'README.md' },
      { path: 'data.json' },
      { path: 'src/lib.py' },
    ]);
    const { result } = runScanning({ repo }, noopCtx());
    expect(result.parseableFiles).toHaveLength(2);
    expect(result.parseableFiles.map((f) => f.path)).toEqual([
      'app.py',
      'src/lib.py',
    ]);
  });

  it('handles empty repo', () => {
    const repo = makeRepoTree([]);
    const { result } = runScanning({ repo }, noopCtx());
    expect(result.fileNodes).toHaveLength(0);
    expect(result.dirNodes.size).toBe(0);
    expect(result.structureRels).toHaveLength(0);
    expect(result.parseableFiles).toHaveLength(0);
    expect(result.repoNode).toBeDefined();
  });

  it('sets sourceUri properties when url/provider are set', () => {
    const repo = makeRepoTree([{ path: 'app.py' }], {
      url: 'https://github.com/testorg/testrepo',
      provider: 'github',
    });
    const { result } = runScanning({ repo }, noopCtx());

    expect(result.repoNode.properties?.sourceUri).toBe(
      'https://github.com/testorg/testrepo',
    );
    expect(result.repoNode.properties?.provider).toBe('github');

    const fileNode = result.fileNodes[0];
    expect(fileNode.properties?.sourceUri).toBe(
      'https://github.com/testorg/testrepo/blob/main/app.py',
    );
  });

  it('emits per-file progress events', () => {
    const repo = makeRepoTree([{ path: 'a.py' }, { path: 'b.py' }]);
    const { events } = runScanning({ repo }, noopCtx());

    const progress = events.filter((e) => e.kind === 'stage_progress');
    expect(progress).toHaveLength(2);
    expect(progress[0].detail?.fileName).toBe('a.py');
    expect(progress[0].detail?.current).toBe(1);
    expect(progress[0].detail?.total).toBe(2);
    expect(progress[1].detail?.fileName).toBe('b.py');
  });

  it('emits stage_start and stage_stop with graph data', () => {
    const repo = makeRepoTree([{ path: 'app.py' }]);
    const { events } = runScanning({ repo }, noopCtx());

    const stageStart = events.find((e) => e.kind === 'stage_start');
    expect(stageStart).toBeDefined();
    expect(stageStart!.phase).toBe('scanning');

    const stageStop = events.find((e) => e.kind === 'stage_stop');
    expect(stageStop).toBeDefined();
    expect(stageStop!.phase).toBe('scanning');
    expect(stageStop!.nodes).toBeDefined();
    expect(stageStop!.relationships).toBeDefined();
  });
});

describe('utility functions', () => {
  it('getExtension', () => {
    expect(getExtension('file.py')).toBe('.py');
    expect(getExtension('path/to/file.ts')).toBe('.ts');
    expect(getExtension('Makefile')).toBe('');
    expect(getExtension('file.')).toBe('');
  });

  it('parentDir', () => {
    expect(parentDir('src/utils/helper.py')).toBe('src/utils');
    expect(parentDir('setup.py')).toBe('');
    expect(parentDir('a/b')).toBe('a');
  });

  it('detectLanguage', () => {
    expect(detectLanguage('.py')).toBe('python');
    expect(detectLanguage('.js')).toBe('javascript');
    expect(detectLanguage('.ts')).toBe('typescript');
    expect(detectLanguage('.go')).toBe('go');
    expect(detectLanguage('')).toBeNull();
    expect(detectLanguage('.xyz')).toBeNull();
  });
});
