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

import { createContext, use, type ReactNode } from 'react';
import { LadybugGraphStore } from './ladybugStore';
import type { GraphStore } from './types';

interface StoreContextValue {
  store: GraphStore;
}

const StoreContext = createContext<StoreContextValue | null>(null);

// Module-level singleton — survives React StrictMode double-invocation.
// Without this, StrictMode creates two LadybugGraphStore instances (two workers,
// two independent in-memory databases), so imports go to one and reads to the other.
let singletonStore: LadybugGraphStore | null = null;
function getStore(): LadybugGraphStore {
  if (!singletonStore) {
    if (!crossOriginIsolated) {
      throw new Error(
        'Cross-Origin Isolation (COOP/COEP headers) is required ' +
          'for in-browser LadybugDB. Serve with appropriate headers.',
      );
    }
    singletonStore = new LadybugGraphStore();
  }
  return singletonStore;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const store = getStore();

  return <StoreContext value={{ store }}>{children}</StoreContext>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore(): StoreContextValue {
  const ctx = use(StoreContext);
  if (!ctx) {
    throw new Error('useStore() must be used within <StoreProvider>');
  }
  return ctx;
}

// Clean up WASM resources on Vite HMR to prevent memory leaks.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    singletonStore?.dispose();
    singletonStore = null;
  });
}
