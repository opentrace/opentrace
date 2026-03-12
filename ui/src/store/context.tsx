import { createContext, use, type ReactNode } from 'react';
import { KuzuGraphStore } from './kuzuStore';
import type { GraphStore } from './types';

interface StoreContextValue {
  store: GraphStore;
}

const StoreContext = createContext<StoreContextValue | null>(null);

// Module-level singleton — survives React StrictMode double-invocation.
// Without this, StrictMode creates two KuzuGraphStore instances (two workers,
// two independent in-memory databases), so imports go to one and reads to the other.
let singletonStore: KuzuGraphStore | null = null;
function getStore(): KuzuGraphStore {
  if (!singletonStore) {
    if (!crossOriginIsolated) {
      throw new Error(
        'Cross-Origin Isolation (COOP/COEP headers) is required ' +
          'for in-browser KuzuDB. Serve with appropriate headers.',
      );
    }
    singletonStore = new KuzuGraphStore();
  }
  return singletonStore;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const store = getStore();

  return <StoreContext value={{ store }}>{children}</StoreContext>;
}

export function useStore(): StoreContextValue {
  const ctx = use(StoreContext);
  if (!ctx) {
    throw new Error('useStore() must be used within <StoreProvider>');
  }
  return ctx;
}
