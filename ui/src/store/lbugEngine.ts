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
 * Main-thread owner of the LadybugDB WASM engine.
 *
 * The lbug engine internally spawns its own Web Worker (via the `threads`
 * library) the first time `init()` runs. That worker MUST be spawned from a
 * context that supports `new Worker()` — and historically that was the main
 * thread. When the LadybugGraphStore moved into `storeWorker` (#399), the lbug
 * engine worker became a *nested* worker (worker-spawned-from-a-worker). On
 * browsers/contexts with weak nested-worker support (older Safari, some
 * in-app WebViews) the nested worker spawns but never reaches `expose()`, so
 * the `threads` library times out after 60s:
 *
 *   "Timeout: Did not receive an init message from worker after 60000ms.
 *    Make sure the worker calls expose()."
 *
 * (Sentry OSS-OPENTRACE-1G.)
 *
 * The fix: keep the engine here, on the main thread, so its worker is a
 * top-level worker again. `storeWorker` reaches it over `postMessage` through
 * the `LbugEngine` RPC surface below — the same shim pattern the embedder
 * already uses. The heavy JS scaffolding (CSV build, BM25, deflate, Parquet,
 * DTO mapping) stays in `storeWorker`; only the raw engine ops cross back.
 */

import lbug from '@ladybugdb/wasm-core';

type Database = InstanceType<typeof lbug.Database>;
type Connection = InstanceType<typeof lbug.Connection>;

/**
 * The minimal LadybugDB engine surface that LadybugGraphStore depends on.
 * Implemented here for real (main thread) and as a postMessage shim inside
 * `storeWorker`. Keeping it this narrow is what lets the store stay in the
 * worker while the engine lives on main.
 */
export interface LbugEngine {
  /** Boot the engine worker, open the in-memory database, open a connection. */
  init(): Promise<void>;
  /** Run a Cypher query and return all rows as plain objects. */
  query(cypher: string): Promise<Record<string, unknown>[]>;
  /** Run a Cypher statement that returns no rows (DDL, COPY, CALL ...). */
  exec(cypher: string): Promise<void>;
  /** Write bytes into the engine's virtual filesystem (for COPY FROM). */
  fsWrite(path: string, data: Uint8Array): Promise<void>;
  /** Remove a file from the engine's virtual filesystem. */
  fsUnlink(path: string): Promise<void>;
  /** Tear down the connection, database, and engine worker. Idempotent. */
  close(): Promise<void>;
}

class MainThreadLbugEngine implements LbugEngine {
  private db: Database | null = null;
  private conn: Connection | null = null;
  private closed = false;

  async init(): Promise<void> {
    lbug.setWorkerPath('/lbug_wasm_worker.js');
    await lbug.init();
    // Buffer pool size note: lbug accepts a `bufferPoolSize` argument here,
    // but in WASM the linear memory is a single shared heap — reserving more
    // for the page cache leaves less for everything else (CSV temp files,
    // query state, parser tables). An explicit 512 MB reservation broke ingest
    // even for small repos, so we let the engine's auto-sizing decide. To
    // genuinely fit larger graphs the right move is to reduce extraction depth
    // or use server mode rather than push this number up.
    this.db = new lbug.Database(':memory:');
    await this.db.init();
    this.conn = new lbug.Connection(this.db);
    await this.conn.init();
    this.closed = false;
  }

  async query(cypher: string): Promise<Record<string, unknown>[]> {
    if (!this.conn) throw new Error('LbugEngine.query before init()');
    const result = await this.conn.query(cypher);
    try {
      return await result.getAllObjects();
    } finally {
      await result.close();
    }
  }

  async exec(cypher: string): Promise<void> {
    if (!this.conn) throw new Error('LbugEngine.exec before init()');
    const result = await this.conn.query(cypher);
    await result.close();
  }

  async fsWrite(path: string, data: Uint8Array): Promise<void> {
    await lbug.FS.writeFile(path, data);
  }

  async fsUnlink(path: string): Promise<void> {
    await lbug.FS.unlink(path);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.conn?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.db?.close();
    } catch {
      /* ignore */
    }
    try {
      await lbug.close();
    } catch {
      /* ignore */
    }
    this.conn = null;
    this.db = null;
  }
}

/** Construct a main-thread LadybugDB engine. */
export function createLbugEngine(): LbugEngine {
  return new MainThreadLbugEngine();
}
