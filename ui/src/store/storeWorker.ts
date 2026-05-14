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

/**
 * Web Worker that hosts the LadybugGraphStore (Fix #56 / Plan D).
 *
 * The lbug-wasm engine already runs in its own internal worker, but every
 * piece of JS scaffolding around it — BM25 build, CSV string generation,
 * source deflate, Parquet read/write, row → DTO mapping — used to run on
 * the main thread and burst the indexing pause. Moving the whole store in
 * here keeps Pixi's ticker rendering smoothly during indexing.
 *
 * Protocol: every request from the main thread carries a numeric `seq`;
 * replies (including `progress` and `embed-request` callbacks) echo it so
 * the proxy can match them to pending Promises / installed callbacks. The
 * worker reaches the embedder by emitting `embed-request` back to main —
 * main owns the WorkerEmbedder and replies with `embed-reply`.
 */

import { LadybugGraphStore } from './ladybugStore';
import type { Embedder } from '../runner/browser/enricher/embedder/types';
import type {
  ImportBatchRequest,
  SourceFile,
} from './types';

type CallMessage = { seq: number; type: 'call'; method: string; args: unknown[] };
type SetEmbedderMessage = { type: 'set-embedder' };
type EmbedReplyMessage = { seq: number; type: 'embed-reply'; vectors: number[][] };
type EmbedErrorMessage = { seq: number; type: 'embed-error'; message: string };

type InMessage =
  | CallMessage
  | SetEmbedderMessage
  | EmbedReplyMessage
  | EmbedErrorMessage;

type OutMessage =
  | { seq: number; type: 'result'; value: unknown }
  | { seq: number; type: 'error'; message: string }
  | { seq: number; type: 'progress'; value: string }
  | { seq: number; type: 'embed-request'; texts: string[] };

const post = (msg: OutMessage, transfer?: Transferable[]): void => {
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    (self as unknown as Worker).postMessage(msg);
  }
};

const store = new LadybugGraphStore();

// --- Embedder shim ---
// When the main-thread proxy calls setEmbedder(), we install this shim
// rather than a real embedder. embed() posts a request back to main; the
// proxy forwards it to the WorkerEmbedder and replies with embed-reply.
let nextEmbedSeq = 1;
const pendingEmbeds = new Map<
  number,
  { resolve: (v: number[][]) => void; reject: (err: Error) => void }
>();
const embedderShim: Embedder = {
  init: async () => {},
  embed: (texts) =>
    new Promise<number[][]>((resolve, reject) => {
      const seq = nextEmbedSeq++;
      pendingEmbeds.set(seq, { resolve, reject });
      post({ seq, type: 'embed-request', texts });
    }),
  dimension: () => 384,
  dispose: async () => {},
};

async function dispatch(msg: CallMessage): Promise<void> {
  const { seq, method, args } = msg;
  try {
    let value: unknown;
    switch (method) {
      case 'ensureReady':
        value = await store.ensureReady();
        break;
      case 'fetchGraph':
        value = await store.fetchGraph(...(args as [string?, number?]));
        break;
      case 'fetchStats':
        value = await store.fetchStats();
        break;
      case 'fetchMetadata':
        value = await store.fetchMetadata();
        break;
      case 'clearGraph':
        value = await store.clearGraph();
        break;
      case 'deleteRepo':
        value = await store.deleteRepo(args[0] as string);
        break;
      case 'setLimits':
        value = await store.setLimits(args[0] as number, args[1] as number);
        break;
      case 'importBatch':
        value = await store.importBatch(args[0] as ImportBatchRequest);
        break;
      case 'flush':
        value = await store.flush();
        break;
      case 'importVectors':
        value = await store.importVectors(
          args[0] as { id: string; vec: number[] }[],
        );
        break;
      case 'importDatabase': {
        // args[1] is a boolean "wants progress" placeholder — the real
        // callback lives on main. Forward each progress message back over
        // the same seq the proxy is waiting on.
        const [data, wantsProgress] = args as [Uint8Array, boolean];
        const onProgress = wantsProgress
          ? (m: string) => post({ seq, type: 'progress', value: m })
          : undefined;
        value = await store.importDatabase(data, onProgress);
        break;
      }
      case 'exportDatabase':
        value = await store.exportDatabase(
          args[0] as { includeSource?: boolean; repoId?: string } | undefined,
        );
        break;
      case 'storeSource':
        store.storeSource(args[0] as SourceFile[]);
        value = undefined;
        break;
      case 'fetchSource':
        value = await store.fetchSource(
          ...(args as [string, number?, number?]),
        );
        break;
      case 'searchNodes':
        value = await store.searchNodes(
          ...(args as [string, number?, string[]?]),
        );
        break;
      case 'listNodes':
        value = await store.listNodes(
          ...(args as [string, number?, Record<string, string>?]),
        );
        break;
      case 'getNode':
        value = await store.getNode(args[0] as string);
        break;
      case 'traverse':
        value = await store.traverse(
          ...(args as [
            string,
            ('outgoing' | 'incoming' | 'both')?,
            number?,
            string?,
          ]),
        );
        break;
      case 'grepSource':
        value = await store.grepSource(
          ...(args as [
            string,
            (
              | {
                  caseSensitive?: boolean;
                  maxResults?: number;
                  fileFilter?: string;
                }
              | undefined
            ),
          ]),
        );
        break;
      case 'dispose':
        value = await store.dispose();
        break;
      default:
        throw new Error(`unknown store method '${method}'`);
    }

    // Transfer Uint8Array buffers back zero-copy when the result is one.
    const transfer: Transferable[] = [];
    if (value instanceof Uint8Array) {
      transfer.push(value.buffer);
    }
    post({ seq, type: 'result', value }, transfer);
  } catch (err) {
    post({
      seq,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (msg.type === 'call') {
    void dispatch(msg);
    return;
  }
  if (msg.type === 'set-embedder') {
    store.setEmbedder(embedderShim);
    return;
  }
  if (msg.type === 'embed-reply') {
    const p = pendingEmbeds.get(msg.seq);
    if (p) {
      pendingEmbeds.delete(msg.seq);
      p.resolve(msg.vectors);
    }
    return;
  }
  if (msg.type === 'embed-error') {
    const p = pendingEmbeds.get(msg.seq);
    if (p) {
      pendingEmbeds.delete(msg.seq);
      p.reject(new Error(msg.message));
    }
    return;
  }
};
