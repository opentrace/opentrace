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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SummarizationStrategy } from '../../enricher/summarizer/strategy';
import type { RepoTree, GraphBatch, ExtractionResult } from '../../types';

// Mock extractors so we can inject symbols without needing real tree-sitter ASTs
const mockExtractPython = vi.fn().mockReturnValue({
  symbols: [],
  language: 'python',
  rootNode: null,
} satisfies ExtractionResult);
const mockExtractTypeScript = vi.fn().mockReturnValue({
  symbols: [],
  language: 'typescript',
  rootNode: null,
} satisfies ExtractionResult);
const mockExtractGo = vi.fn().mockReturnValue({
  symbols: [],
  language: 'go',
  rootNode: null,
} satisfies ExtractionResult);
const mockExtractGeneric = vi.fn().mockReturnValue({
  symbols: [],
  language: 'generic',
  rootNode: null,
} satisfies ExtractionResult);

vi.mock('@opentrace/components/pipeline', async (importOriginal) => {
  const original = await importOriginal<typeof import('@opentrace/components/pipeline')>();
  return {
    ...original,
    extractPython: (...args: unknown[]) => mockExtractPython(...args),
    extractTypeScript: (...args: unknown[]) => mockExtractTypeScript(...args),
    extractGo: (...args: unknown[]) => mockExtractGo(...args),
    extractGeneric: (...args: unknown[]) => mockExtractGeneric(...args),
    analyzeImports: () => ({ internal: {}, external: {} }),
  };
});

import {
  runPipeline,
  type ParserMap,
  type PipelineCallbacks,
} from '../pipeline';

function makeRepo(overrides?: Partial<RepoTree>): RepoTree {
  return {
    owner: 'testowner',
    repo: 'testrepo',
    ref: 'main',
    url: 'https://github.com/testowner/testrepo',
    provider: 'github',
    files: [],
    ...overrides,
  };
}

function makeCallbacks(): PipelineCallbacks & {
  batches: GraphBatch[];
  progressCalls: string[];
  stageCalls: string[];
} {
  const batches: GraphBatch[] = [];
  const progressCalls: string[] = [];
  const stageCalls: string[] = [];
  return {
    batches,
    progressCalls,
    stageCalls,
    onBatch: vi.fn((batch: GraphBatch) => batches.push(batch)),
    onProgress: vi.fn((phase: string) => progressCalls.push(phase)),
    onStageComplete: vi.fn((phase: string) => stageCalls.push(phase)),
  };
}

function makeNoopStrategy(): SummarizationStrategy {
  return {
    type: 'none',
    init: vi.fn().mockResolvedValue(undefined),
    summarize: vi.fn().mockResolvedValue(''),
    summarizeBatch: vi.fn().mockResolvedValue([]),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTemplateStrategy(): SummarizationStrategy {
  // Mimics the real template strategy — returns a deterministic summary
  return {
    type: 'template',
    init: vi.fn().mockResolvedValue(undefined),
    summarize: vi.fn().mockImplementation(async (meta) => {
      if (meta.kind === 'function') return `Retrieves ${meta.name}`;
      if (meta.kind === 'class') return `${meta.name} class`;
      if (meta.kind === 'file') return `Source file ${meta.name}`;
      if (meta.kind === 'directory') return `Directory ${meta.name}`;
      return '';
    }),
    summarizeBatch: vi.fn().mockResolvedValue([]),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

// Empty ParserMap — no actual parsing. Pipeline still builds structure.
const emptyParsers: ParserMap = new Map();

// Mock parser that returns a tree with rootNode
function makeMockParsers(): ParserMap {
  const mockTree = {
    rootNode: {
      type: 'program',
      childCount: 0,
      children: [],
      namedChildren: [],
      text: '',
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 0 },
      descendantsOfType: () => [],
      childForFieldName: () => null,
    },
  };
  const mockParser = {
    parse: vi.fn().mockReturnValue(mockTree),
  };
  const map = new Map();
  map.set('python', mockParser);
  map.set('typescript', mockParser);
  map.set('go', mockParser);
  map.set('tsx', mockParser);
  return map as unknown as ParserMap;
}

describe('runPipeline', () => {
  it('creates Repository node with correct ID and properties', async () => {
    const callbacks = makeCallbacks();
    await runPipeline(makeRepo(), emptyParsers, callbacks, makeNoopStrategy());

    const allNodes = callbacks.batches.flatMap((b) => b.nodes);
    const repoNode = allNodes.find((n) => n.type === 'Repository');
    expect(repoNode).toBeDefined();
    expect(repoNode!.id).toBe('testowner/testrepo');
    expect(repoNode!.name).toBe('testrepo');
    expect(repoNode!.properties?.owner).toBe('testowner');
    expect(repoNode!.properties?.ref).toBe('main');
  });

  it('creates File nodes per file', async () => {
    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        {
          path: 'src/main.ts',
          content: 'console.log("hi")',
          sha: '',
          size: 20,
        },
        { path: 'README.md', content: '# Hello', sha: '', size: 10 },
      ],
    });
    await runPipeline(repo, emptyParsers, callbacks, makeNoopStrategy());

    const allNodes = callbacks.batches.flatMap((b) => b.nodes);
    const fileNodes = allNodes.filter((n) => n.type === 'File');
    expect(fileNodes.length).toBeGreaterThanOrEqual(2);
    expect(fileNodes.find((n) => n.name === 'main.ts')).toBeDefined();
    expect(fileNodes.find((n) => n.name === 'README.md')).toBeDefined();
  });

  it('creates Directory nodes with DEFINED_IN relationships', async () => {
    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [{ path: 'src/utils/helper.ts', content: '', sha: '', size: 0 }],
    });
    await runPipeline(repo, emptyParsers, callbacks, makeNoopStrategy());

    const allNodes = callbacks.batches.flatMap((b) => b.nodes);
    const dirNodes = allNodes.filter((n) => n.type === 'Directory');
    expect(dirNodes.find((n) => n.name === 'src')).toBeDefined();
    expect(dirNodes.find((n) => n.name === 'utils')).toBeDefined();

    const allRels = callbacks.batches.flatMap((b) => b.relationships);
    const definedInRels = allRels.filter((r) => r.type === 'DEFINED_IN');
    expect(definedInRels.length).toBeGreaterThan(0);
  });

  it('calls onBatch, onProgress, and onStageComplete', async () => {
    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        { path: 'main.py', content: 'def hello(): pass', sha: '', size: 20 },
      ],
    });
    await runPipeline(repo, makeMockParsers(), callbacks, makeNoopStrategy());

    expect(callbacks.onBatch).toHaveBeenCalled();
    expect(callbacks.batches.length).toBeGreaterThan(0);
    expect(callbacks.onProgress).toHaveBeenCalled();
    expect(callbacks.progressCalls).toContain('parsing');
    expect(callbacks.onStageComplete).toHaveBeenCalled();
    expect(callbacks.stageCalls).toContain('parsing');
    expect(callbacks.stageCalls).toContain('resolving');
  });

  it('skips files without parseable language', async () => {
    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        { path: 'data.csv', content: 'a,b,c', sha: '', size: 5 },
        { path: 'notes.txt', content: 'hello', sha: '', size: 5 },
      ],
    });
    const result = await runPipeline(
      repo,
      emptyParsers,
      callbacks,
      makeNoopStrategy(),
    );

    expect(result.filesProcessed).toBe(0);
  });

  it('returns correct totals', async () => {
    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [{ path: 'src/main.ts', content: '// code', sha: '', size: 10 }],
    });
    const result = await runPipeline(
      repo,
      emptyParsers,
      callbacks,
      makeNoopStrategy(),
    );

    // Should at least have the repo node, directory node, file node
    expect(result.nodesCreated).toBeGreaterThanOrEqual(3);
    // DEFINED_IN relationships
    expect(result.relationshipsCreated).toBeGreaterThanOrEqual(1);
  });

  it('collects errors without crashing', async () => {
    const callbacks = makeCallbacks();
    // A parser that throws
    const badParser = {
      parse: vi.fn().mockImplementation(() => {
        throw new Error('parse error');
      }),
    };
    const parsers = new Map([['python', badParser]]) as unknown as ParserMap;
    const repo = makeRepo({
      files: [
        { path: 'bad.py', content: 'syntax error!!!', sha: '', size: 10 },
      ],
    });
    const result = await runPipeline(
      repo,
      parsers,
      callbacks,
      makeNoopStrategy(),
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('bad.py');
  });

  it('handles Dockerfile extension special case', async () => {
    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        { path: 'Dockerfile', content: 'FROM node:18', sha: '', size: 15 },
      ],
    });
    await runPipeline(repo, emptyParsers, callbacks, makeNoopStrategy());

    const allNodes = callbacks.batches.flatMap((b) => b.nodes);
    const fileNode = allNodes.find((n) => n.name === 'Dockerfile');
    expect(fileNode).toBeDefined();
    expect(fileNode!.properties?.extension).toBe('.dockerfile');
  });

  it('parentDir returns empty for root files', async () => {
    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [{ path: 'main.go', content: 'package main', sha: '', size: 15 }],
    });
    await runPipeline(repo, emptyParsers, callbacks, makeNoopStrategy());

    // Root file should link directly to repo node
    const allRels = callbacks.batches.flatMap((b) => b.relationships);
    const fileRel = allRels.find(
      (r) =>
        r.source_id === 'testowner/testrepo/main.go' && r.type === 'DEFINED_IN',
    );
    expect(fileRel?.target_id).toBe('testowner/testrepo');
  });
});

// ---------------------------------------------------------------------------
// Summary generation tests
// ---------------------------------------------------------------------------

describe('runPipeline summary generation', () => {
  beforeEach(() => {
    mockExtractPython.mockReset();
    mockExtractTypeScript.mockReset();
    mockExtractGo.mockReset();
    mockExtractGeneric.mockReset();
  });

  function makeSymbolExtraction(
    symbols: ExtractionResult['symbols'],
    language = 'python',
  ): ExtractionResult {
    return { symbols, language, rootNode: null };
  }

  it('merges function summary into the same node (no duplicate nodes)', async () => {
    mockExtractPython.mockReturnValue(
      makeSymbolExtraction([
        {
          name: 'getUserById',
          kind: 'function',
          startLine: 1,
          endLine: 3,
          signature: '(user_id: int)',
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
        },
      ]),
    );

    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        {
          path: 'users.py',
          content:
            'def getUserById(user_id: int):\n    return db.get(user_id)\n',
          sha: '',
          size: 50,
        },
      ],
    });
    const strategy = makeTemplateStrategy();
    await runPipeline(repo, makeMockParsers(), callbacks, strategy);

    const allNodes = callbacks.batches.flatMap((b) => b.nodes);

    // Should have exactly ONE Function node, not two
    const funcNodes = allNodes.filter(
      (n) => n.type === 'Function' && n.name === 'getUserById',
    );
    expect(funcNodes).toHaveLength(1);

    // That node should have both the original properties AND the summary
    const funcNode = funcNodes[0];
    expect(funcNode.properties?.summary).toBe('Retrieves getUserById');
    expect(funcNode.properties?.language).toBe('python');
    expect(funcNode.properties?.start_line).toBe(1);
    expect(funcNode.properties?.end_line).toBe(3);
  });

  it('merges class summary into the same node', async () => {
    mockExtractPython.mockReturnValue(
      makeSymbolExtraction([
        {
          name: 'UserService',
          kind: 'class',
          startLine: 1,
          endLine: 10,
          signature: null,
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
        },
      ]),
    );

    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        {
          path: 'service.py',
          content: 'class UserService:\n    pass\n' + '\n'.repeat(8),
          sha: '',
          size: 50,
        },
      ],
    });
    await runPipeline(
      repo,
      makeMockParsers(),
      callbacks,
      makeTemplateStrategy(),
    );

    const allNodes = callbacks.batches.flatMap((b) => b.nodes);
    const classNodes = allNodes.filter(
      (n) => n.type === 'Class' && n.name === 'UserService',
    );
    expect(classNodes).toHaveLength(1);
    expect(classNodes[0].properties?.summary).toBe('UserService class');
    expect(classNodes[0].properties?.language).toBe('python');
  });

  it('emits file summary as a separate update node', async () => {
    mockExtractPython.mockReturnValue(
      makeSymbolExtraction([
        {
          name: 'hello',
          kind: 'function',
          startLine: 1,
          endLine: 2,
          signature: '()',
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
        },
      ]),
    );

    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        {
          path: 'hello.py',
          content: 'def hello():\n    print("hi")\n',
          sha: '',
          size: 30,
        },
      ],
    });
    await runPipeline(
      repo,
      makeMockParsers(),
      callbacks,
      makeTemplateStrategy(),
    );

    const allNodes = callbacks.batches.flatMap((b) => b.nodes);
    // File summary update node should have summary property
    const fileSummaryNodes = allNodes.filter(
      (n) =>
        n.type === 'File' && n.name === 'hello.py' && n.properties?.summary,
    );
    expect(fileSummaryNodes.length).toBeGreaterThanOrEqual(1);
    expect(fileSummaryNodes[0].properties?.summary).toBe(
      'Source file hello.py',
    );
  });

  it('includes summaries in enrichItems', async () => {
    mockExtractPython.mockReturnValue(
      makeSymbolExtraction([
        {
          name: 'processData',
          kind: 'function',
          startLine: 1,
          endLine: 3,
          signature: '(data)',
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
        },
      ]),
    );

    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        {
          path: 'process.py',
          content: 'def processData(data):\n    return data\n',
          sha: '',
          size: 40,
        },
      ],
    });
    const result = await runPipeline(
      repo,
      makeMockParsers(),
      callbacks,
      makeTemplateStrategy(),
    );

    // enrichItems should contain function + file entries with summaries
    const funcEnrich = result.enrichItems.find(
      (e) => e.kind === 'function' && e.nodeName === 'processData',
    );
    expect(funcEnrich).toBeDefined();
    expect(funcEnrich!.summary).toBe('Retrieves processData');

    const fileEnrich = result.enrichItems.find(
      (e) => e.kind === 'file' && e.nodeName === 'process.py',
    );
    expect(fileEnrich).toBeDefined();
    expect(fileEnrich!.summary).toBe('Source file process.py');
  });

  it('generates directory summaries for directories with children', async () => {
    mockExtractPython.mockReturnValue(
      makeSymbolExtraction([
        {
          name: 'helper',
          kind: 'function',
          startLine: 1,
          endLine: 2,
          signature: '()',
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
        },
      ]),
    );

    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        {
          path: 'utils/helper.py',
          content: 'def helper():\n    pass\n',
          sha: '',
          size: 20,
        },
      ],
    });
    const result = await runPipeline(
      repo,
      makeMockParsers(),
      callbacks,
      makeTemplateStrategy(),
    );

    const dirEnrich = result.enrichItems.find(
      (e) => e.kind === 'directory' && e.nodeName === 'utils',
    );
    expect(dirEnrich).toBeDefined();
    expect(dirEnrich!.summary).toBe('Directory utils');
  });

  it('strategy.summarize is called for each symbol', async () => {
    mockExtractPython.mockReturnValue(
      makeSymbolExtraction([
        {
          name: 'funcA',
          kind: 'function',
          startLine: 1,
          endLine: 2,
          signature: '()',
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
        },
        {
          name: 'funcB',
          kind: 'function',
          startLine: 3,
          endLine: 4,
          signature: '()',
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
        },
      ]),
    );

    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        {
          path: 'multi.py',
          content: 'def funcA():\n    pass\ndef funcB():\n    pass\n',
          sha: '',
          size: 40,
        },
      ],
    });
    const strategy = makeTemplateStrategy();
    await runPipeline(repo, makeMockParsers(), callbacks, strategy);

    // strategy.summarize should be called for: funcA, funcB, file, directory(ies)
    expect(strategy.summarize).toHaveBeenCalled();
    const calls = (strategy.summarize as ReturnType<typeof vi.fn>).mock.calls;
    const funcCalls = calls.filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'function',
    );
    expect(funcCalls).toHaveLength(2);
    expect(
      funcCalls.map((c: unknown[]) => (c[0] as { name: string }).name).sort(),
    ).toEqual(['funcA', 'funcB']);
  });

  it('noop strategy produces no summary properties on symbol nodes', async () => {
    mockExtractPython.mockReturnValue(
      makeSymbolExtraction([
        {
          name: 'noSummary',
          kind: 'function',
          startLine: 1,
          endLine: 2,
          signature: '()',
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
        },
      ]),
    );

    const callbacks = makeCallbacks();
    const repo = makeRepo({
      files: [
        {
          path: 'empty.py',
          content: 'def noSummary():\n    pass\n',
          sha: '',
          size: 25,
        },
      ],
    });
    await runPipeline(repo, makeMockParsers(), callbacks, makeNoopStrategy());

    const allNodes = callbacks.batches.flatMap((b) => b.nodes);
    const funcNodes = allNodes.filter(
      (n) => n.type === 'Function' && n.name === 'noSummary',
    );
    // With noop strategy, summary is '' (falsy), so it should NOT be added to properties
    for (const node of funcNodes) {
      expect(node.properties?.summary).toBeUndefined();
    }
  });
});
