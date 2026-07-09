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
 * CompileJobProvider — runs vault compilation in the *background*.
 *
 * The old flow streamed compile progress inside AddVaultModal, so the user
 * had to keep the modal open until it finished. This provider lifts the
 * compile stream up to the app shell: the modal only *starts* a compile and
 * closes, while a bottom-left CompileProgressPanel reports progress, exposes
 * the log stream on click, and offers a cancel button.
 *
 * Cancel aborts the in-flight fetch and, for a freshly-created vault, deletes
 * the partial artifact from disk ("delete all compilation progress"). When
 * appending to a vault that already existed we abort but keep the vault so a
 * cancel can't wipe pages the user compiled earlier.
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { compileVault, deleteVault } from '../wiki/client';
import type { VaultScope, WikiCompileEvent, WikiPhase } from '../wiki/types';
import { useGraph } from './GraphDataProvider';

export type CompileStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelling'
  | 'cancelled';

export interface CompileJobState {
  status: CompileStatus;
  vaultName: string;
  scope: VaultScope;
  phase: WikiPhase | null;
  message: string;
  current: number;
  total: number;
  logs: string[];
  error: string | null;
}

export interface CompileStartParams {
  vaultName: string;
  files: File[];
  apiKey: string;
  provider: string;
  baseUrl?: string;
  scope: VaultScope;
  /** True when this compile creates a brand-new vault (vs. appending to an
   *  existing one). Governs whether cancel deletes the whole vault. */
  isNew: boolean;
}

interface CompileJobContextValue {
  state: CompileJobState;
  /** Kick off a background compile. No-op if one is already running. */
  start: (params: CompileStartParams) => void;
  /** Abort the running compile and delete its progress (new vaults only). */
  cancel: () => void;
  /** Clear a finished/errored/cancelled job from the UI. */
  dismiss: () => void;
}

const IDLE_STATE: CompileJobState = {
  status: 'idle',
  vaultName: '',
  scope: 'local',
  phase: null,
  message: '',
  current: 0,
  total: 0,
  logs: [],
  error: null,
};

const CompileJobContext = createContext<CompileJobContextValue | null>(null);

function formatEvent(ev: WikiCompileEvent): string {
  if (ev.kind === 'stage_start') return `[${ev.phase}] ▶ ${ev.message}`;
  if (ev.kind === 'stage_progress') {
    const tag = ev.total ? `[${ev.current}/${ev.total}]` : '';
    return `  ${tag} ${ev.message}`;
  }
  if (ev.kind === 'stage_stop') return `[${ev.phase}] ✓ ${ev.message}`;
  if (ev.kind === 'done') return `✓ ${ev.message}`;
  return `✗ ${ev.message}`;
}

export function CompileJobProvider({ children }: { children: ReactNode }) {
  const { loadGraph } = useGraph();
  const [state, setState] = useState<CompileJobState>(IDLE_STATE);
  const abortRef = useRef<AbortController | null>(null);
  // Mirror the target so cancel() (which fires after async setState) can act
  // on the current job without threading it through React state.
  const targetRef = useRef<{
    vaultName: string;
    scope: VaultScope;
    isNew: boolean;
  } | null>(null);

  const start = useCallback(
    (params: CompileStartParams) => {
      // Guard against a second compile clobbering an in-flight one.
      if (abortRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      targetRef.current = {
        vaultName: params.vaultName,
        scope: params.scope,
        isNew: params.isNew,
      };

      setState({
        status: 'running',
        vaultName: params.vaultName,
        scope: params.scope,
        phase: null,
        message: 'Starting compile…',
        current: 0,
        total: 0,
        logs: [],
        error: null,
      });

      void (async () => {
        let sawError = false;
        let sawDone = false;
        try {
          for await (const ev of compileVault(
            params.vaultName,
            params.files,
            params.apiKey,
            {
              provider: params.provider,
              baseUrl: params.baseUrl,
              scope: params.scope,
              signal: controller.signal,
            },
          )) {
            if (ev.kind === 'error') sawError = true;
            if (ev.kind === 'done') sawDone = true;
            setState((s) => ({
              ...s,
              phase: ev.phase ?? s.phase,
              message: ev.message || s.message,
              current: ev.current ?? s.current,
              total: ev.total ?? s.total,
              logs: [...s.logs, formatEvent(ev)],
              error: ev.kind === 'error' ? ev.message : s.error,
            }));
          }
          if (sawDone && !sawError) {
            setState((s) => ({ ...s, status: 'done', message: 'Compiled' }));
            void loadGraph();
          } else {
            setState((s) => ({ ...s, status: 'error' }));
          }
        } catch (e) {
          // An abort surfaces here as an AbortError — cancel() owns the
          // resulting UI state, so don't overwrite it.
          if (controller.signal.aborted) return;
          const msg = e instanceof Error ? e.message : String(e);
          setState((s) => ({
            ...s,
            status: 'error',
            error: msg,
            logs: [...s.logs, `✗ ${msg}`],
          }));
        } finally {
          abortRef.current = null;
        }
      })();
    },
    [loadGraph],
  );

  const cancel = useCallback(() => {
    const target = targetRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => ({ ...s, status: 'cancelling', message: 'Cancelling…' }));

    void (async () => {
      // Delete the partial vault only when this compile created it — an
      // append to a pre-existing vault must not wipe earlier pages.
      if (target?.isNew) {
        try {
          await deleteVault(target.vaultName, target.scope);
        } catch (err) {
          console.warn('[CompileJob] cleanup delete failed:', err);
        }
      }
      void loadGraph();
      setState((s) => ({
        ...s,
        status: 'cancelled',
        message: 'Compilation cancelled',
      }));
    })();
  }, [loadGraph]);

  const dismiss = useCallback(() => setState(IDLE_STATE), []);

  return (
    <CompileJobContext.Provider value={{ state, start, cancel, dismiss }}>
      {children}
    </CompileJobContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located hook + provider
export function useCompileJob(): CompileJobContextValue {
  const ctx = useContext(CompileJobContext);
  if (!ctx) {
    throw new Error('useCompileJob must be used within a CompileJobProvider');
  }
  return ctx;
}
