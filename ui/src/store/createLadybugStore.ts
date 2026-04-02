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

import { LadybugGraphStore } from './ladybugStore';

// Module-level singleton — survives React StrictMode double-invocation.
// Without this, StrictMode creates two LadybugGraphStore instances (two workers,
// two independent in-memory databases), so imports go to one and reads to the other.
let singletonStore: LadybugGraphStore | null = null;

/** Returns a singleton LadybugGraphStore backed by the in-browser WASM engine. */
export function createLadybugStore(): LadybugGraphStore {
  if (!singletonStore) {
    singletonStore = new LadybugGraphStore();
  }
  return singletonStore;
}

// Clean up WASM resources on Vite HMR to prevent memory leaks.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    singletonStore?.dispose();
    singletonStore = null;
  });
}
