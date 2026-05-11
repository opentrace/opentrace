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

import { createContext, useContext, type ReactNode } from 'react';
import { useGraphData, type GraphDataState } from '../hooks/useGraphData';

const GraphDataContext = createContext<GraphDataState | null>(null);

interface GraphDataProviderProps {
  children: ReactNode;
  /**
   * When provided, the provider exposes this value directly instead of
   * calling `useGraphData()` to fetch from the configured store. Use for
   * apps that own their own data flow (e.g. a Neo4j-backed viewer) and
   * want downstream consumers (SidePanel, ChatPanel) to read it via the
   * standard context.
   *
   * The presence/absence of `value` must be stable for a given mounted
   * provider — don't toggle between modes after mount.
   */
  value?: GraphDataState;
}

export function GraphDataProvider({ children, value }: GraphDataProviderProps) {
  if (value !== undefined) {
    return (
      <GraphDataContext.Provider value={value}>
        {children}
      </GraphDataContext.Provider>
    );
  }
  return <InternalGraphDataProvider>{children}</InternalGraphDataProvider>;
}

function InternalGraphDataProvider({ children }: { children: ReactNode }) {
  const value = useGraphData();
  return (
    <GraphDataContext.Provider value={value}>
      {children}
    </GraphDataContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located hook + provider
export function useGraph(): GraphDataState {
  const ctx = useContext(GraphDataContext);
  if (!ctx) {
    throw new Error('useGraph must be used within a GraphDataProvider');
  }
  return ctx;
}
