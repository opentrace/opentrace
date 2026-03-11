import { createContext, use, useMemo, type ReactNode } from "react";
import { KuzuGraphStore } from "./kuzuStore";
import type { GraphStore } from "./types";

interface StoreContextValue {
  store: GraphStore;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => {
    if (!crossOriginIsolated) {
      throw new Error(
        "Cross-Origin Isolation (COOP/COEP headers) is required " +
        "for in-browser KuzuDB. Serve with appropriate headers.",
      );
    }
    return new KuzuGraphStore();
  }, []);

  return (
    <StoreContext value={{ store }}>
      {children}
    </StoreContext>
  );
}

export function useStore(): StoreContextValue {
  const ctx = use(StoreContext);
  if (!ctx) {
    throw new Error("useStore() must be used within <StoreProvider>");
  }
  return ctx;
}
