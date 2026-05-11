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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbedStage } from '../concurrent/stages';
import type { GraphNode } from '../types';
import type { GraphStore } from '../../../store/types';

// EmbedStage.ensureModel resolves the embedder via a dynamic import. The mock
// factory below replaces that module so tests can inject failure modes
// (init() rejects, embed() throws on a specific batch, etc.) without pulling
// in the real ONNX/transformers stack.
vi.mock('../../../runner/browser/enricher/embedder/miniLmEmbedder', () => ({
  MiniLmEmbedder: vi.fn(),
}));

const fileNode = (id: string): GraphNode => ({
  id,
  type: 'File',
  name: id,
});

const makeStore = (): GraphStore => ({
  hasData: () => false,
  fetchGraph: vi.fn().mockResolvedValue({ nodes: [], links: [] }),
  fetchStats: vi.fn().mockResolvedValue({}),
  fetchMetadata: vi.fn().mockResolvedValue([]),
  clearGraph: vi.fn().mockResolvedValue(undefined),
  importBatch: vi.fn().mockResolvedValue({
    nodes_created: 0,
    relationships_created: 0,
  }),
  flush: vi.fn().mockResolvedValue(undefined),
  setEmbedder: vi.fn(),
  importVectors: vi.fn().mockResolvedValue(undefined),
  storeSource: vi.fn(),
  fetchSource: vi.fn().mockResolvedValue(null),
  searchNodes: vi.fn().mockResolvedValue([]),
  listNodes: vi.fn().mockResolvedValue([]),
  getNode: vi.fn().mockResolvedValue(null),
  traverse: vi.fn().mockResolvedValue([]),
});

describe('EmbedStage error visibility', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let MiniLmEmbedderMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod =
      await import('../../../runner/browser/enricher/embedder/miniLmEmbedder');
    MiniLmEmbedderMock = vi.mocked(mod.MiniLmEmbedder);
    MiniLmEmbedderMock.mockReset();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('logs init failure and skips embedding without throwing', async () => {
    MiniLmEmbedderMock.mockImplementation(() => ({
      init: vi.fn().mockRejectedValue(new Error('test: init failed')),
      embed: vi.fn(),
      dimension: () => 384,
      dispose: vi.fn().mockResolvedValue(undefined),
    }));

    const store = makeStore();
    const stage = new EmbedStage({
      config: { enabled: true, model: 'test-model' },
      store,
    });
    stage.process(fileNode('a.ts'));
    stage.process(fileNode('b.ts'));

    // settle must not throw — graceful degradation is the design contract.
    await expect(stage.settle()).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[EmbedStage] embedder init failed:',
      expect.any(Error),
    );
    expect(stage.embeddedCount).toBe(0);
    expect(store.importVectors).not.toHaveBeenCalled();
    expect(store.setEmbedder).not.toHaveBeenCalled();
  });

  it('logs batch failure and continues with the next batch', async () => {
    let embedCallCount = 0;
    MiniLmEmbedderMock.mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      embed: vi.fn().mockImplementation(async (texts: string[]) => {
        embedCallCount++;
        if (embedCallCount === 1) {
          throw new Error('test: toxic batch');
        }
        return texts.map(() => [0.1, 0.2, 0.3]);
      }),
      dimension: () => 3,
      dispose: vi.fn().mockResolvedValue(undefined),
    }));

    const store = makeStore();
    const stage = new EmbedStage({
      config: { enabled: true, model: 'test-model' },
      store,
    });

    // 16 nodes split into 2 batches of 8. Batch #1 throws, batch #2 succeeds.
    for (let i = 0; i < 16; i++) stage.process(fileNode(`f${i}.ts`));

    await stage.settle();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[EmbedStage] batch failed (offset 0, size 8)'),
      expect.any(Error),
    );
    // Second batch (8 vectors) was persisted; first batch was dropped.
    expect(stage.embeddedCount).toBe(8);
    expect(store.importVectors).toHaveBeenCalledTimes(1);
  });
});
