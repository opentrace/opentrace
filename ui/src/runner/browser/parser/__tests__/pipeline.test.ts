import { describe, it, expect, vi } from 'vitest';
import { runPipeline, type ParserMap, type PipelineCallbacks } from '../pipeline';
import type { SummarizationStrategy } from '../../enricher/summarizer/strategy';
import type { RepoTree, GraphBatch } from '../../types';

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
  return {
    type: 'template',
    init: vi.fn().mockResolvedValue(undefined),
    summarize: vi.fn().mockResolvedValue('A summary'),
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
        { path: 'src/main.ts', content: 'console.log("hi")', sha: '', size: 20 },
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
      files: [
        { path: 'src/utils/helper.ts', content: '', sha: '', size: 0 },
      ],
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
      files: [
        { path: 'src/main.ts', content: '// code', sha: '', size: 10 },
      ],
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
      files: [
        { path: 'main.go', content: 'package main', sha: '', size: 15 },
      ],
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
