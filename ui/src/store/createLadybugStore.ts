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

import { WorkerGraphStore } from './workerStore';

// Module-level singleton — survives React StrictMode double-invocation.
// Without this, StrictMode creates two stores (two workers, two independent
// in-memory databases), so imports go to one and reads to the other.
let singletonStore: WorkerGraphStore | null = null;

/** Returns a singleton store backed by the in-browser WASM engine.
 *  The LadybugGraphStore class is hosted inside a Web Worker; this returns
 *  a thin main-thread proxy implementing the same GraphStore interface. */
export function createLadybugStore(): WorkerGraphStore {
  if (!singletonStore) {
    singletonStore = new WorkerGraphStore();
  }
  return singletonStore;
}

/** Dispose and clear the singleton store, terminating its Web Worker.
 *  Call when leaving in-memory mode (e.g. switching to a server backend)
 *  so the worker and its WASM database don't linger for the lifetime of
 *  the page. A later createLadybugStore() transparently rebuilds it. */
export function disposeLadybugStore(): void {
  singletonStore?.dispose();
  singletonStore = null;
}

// Clean up WASM resources on Vite HMR to prevent memory leaks.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    singletonStore?.dispose();
    singletonStore = null;
  });
}
