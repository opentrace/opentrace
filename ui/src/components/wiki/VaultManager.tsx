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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  attachVault,
  deleteVault,
  demoteVault,
  detachVault,
  listVaults,
  promoteVault,
  type VaultView,
} from '../../wiki/client';
import type { VaultEntry, VaultScope } from '../../wiki/types';
import { AddVaultModal } from './AddVaultModal';
import { useGraph } from '../../providers/GraphDataProvider';
import { useCompileJob } from '../../providers/CompileJobProvider';
import './wiki.css';

interface Props {
  onClose: () => void;
}

/**
 * Vault *management* surface — compile, attach/detach, and delete vaults.
 * Reading a vault's pages is NOT here: a Page is a graph node, so its
 * body renders in the node Details panel when you select it (mirroring how
 * a File node shows its source). This keeps the vault a first-class graph
 * citizen rather than a separate reader app. Rendered as a modal so it
 * never stacks on the left-edge SidePanel the way the old drawer did.
 */
export function VaultManager({ onClose }: Props) {
  const [view, setView] = useState<VaultView>('project');
  const [projectVaults, setProjectVaults] = useState<VaultEntry[]>([]);
  const [globalVaults, setGlobalVaults] = useState<VaultEntry[]>([]);
  // The shared compile modal, or null when closed. `appendTo` set → append
  // files to that existing vault; absent → create a new vault.
  const [addModal, setAddModal] = useState<{
    scope: VaultScope;
    appendTo?: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { loadGraph } = useGraph();
  const { state: compileState } = useCompileJob();

  const entries = view === 'project' ? projectVaults : globalVaults;

  const refreshVaults = useCallback(async () => {
    try {
      const [proj, glob] = await Promise.all([
        listVaults('project'),
        listVaults('global'),
      ]);
      setProjectVaults(proj);
      setGlobalVaults(glob);
    } catch (e) {
      // Treat unreachable backend the same as an empty vault list — the UI
      // shows "No vaults yet" rather than a fetch error. The reason is logged
      // for debugging.
      console.warn('[VaultManager] listVaults failed:', e);
      setProjectVaults([]);
      setGlobalVaults([]);
    }
  }, []);

  useEffect(() => {
    // refreshVaults is async — its setState calls run after await, but the
    // react-hooks/set-state-in-effect rule can't see through the function
    // boundary. Suppressing here is a deliberate "the work is async, trust me".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshVaults();
  }, [refreshVaults]);

  // A background compile mutates disk + graph outside this component. When one
  // settles, refresh the vault list so the new/removed vault shows up, and
  // surface the relevant tab on a clean compile. (The provider already reloads
  // the graph itself.)
  const prevCompileStatus = useRef(compileState.status);
  useEffect(() => {
    const prev = prevCompileStatus.current;
    prevCompileStatus.current = compileState.status;
    if (prev === compileState.status) return;
    if (compileState.status === 'running') {
      // A compile just kicked off (from the AddVaultModal, which closes
      // itself). Close the manager too so the user lands back on the graph
      // with the bottom-left CompileProgressPanel — not a stale modal stack.
      onClose();
      return;
    }
    if (compileState.status === 'done' || compileState.status === 'cancelled') {
      // refreshVaults setStates after an await (safe); setView is a cheap
      // transition gated on an actual status change. Both are deliberate.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refreshVaults();
      if (compileState.status === 'done') {
        // A local compile lands in Project; a global compile lands in Global,
        // and only appears in Project once attached.
        setView(compileState.scope === 'local' ? 'project' : 'global');
      }
    }
  }, [compileState.status, compileState.scope, refreshVaults, onClose]);

  const handleDeleteVault = useCallback(
    async (entry: VaultEntry) => {
      const ok = window.confirm(
        `Delete ${entry.scope} vault "${entry.name}"? This removes all of its pages from disk` +
          (entry.scope === 'global'
            ? ` and detaches it from every project on this machine.`
            : ` and from the project's graph.`),
      );
      if (!ok) return;
      setBusy(entry.name);
      try {
        await deleteVault(entry.name, entry.scope);
      } catch (e) {
        console.warn('[VaultManager] deleteVault failed:', e);
        setBusy(null);
        return;
      }
      await refreshVaults();
      setBusy(null);
      // Reload the graph so the deleted vault's nodes/edges disappear
      // without a hard refresh.
      void loadGraph();
    },
    [refreshVaults, loadGraph],
  );

  const handleDetachGlobal = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        await detachVault(name);
      } catch (e) {
        console.warn('[VaultManager] detachVault failed:', e);
        setBusy(null);
        return;
      }
      await refreshVaults();
      setBusy(null);
      void loadGraph();
    },
    [refreshVaults, loadGraph],
  );

  const handleAttachGlobal = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        await attachVault(name);
      } catch (e) {
        console.warn('[VaultManager] attachVault failed:', e);
        setBusy(null);
        return;
      }
      await refreshVaults();
      setBusy(null);
      void loadGraph();
    },
    [refreshVaults, loadGraph],
  );

  const handlePromote = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        await promoteVault(name);
      } catch (e) {
        console.warn('[VaultManager] promoteVault failed:', e);
        setBusy(null);
        return;
      }
      await refreshVaults();
      setBusy(null);
      // Re-mirror changed the Vault node's scope; reload so the badge and
      // Global tab reflect the new scope without a hard refresh.
      void loadGraph();
    },
    [refreshVaults, loadGraph],
  );

  const handleDemote = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        await demoteVault(name);
      } catch (e) {
        console.warn('[VaultManager] demoteVault failed:', e);
        setBusy(null);
        return;
      }
      await refreshVaults();
      setBusy(null);
      // The vault is now local — surface where it went by switching to the
      // Project tab, and reload so scope/badges update without a refresh.
      setView('project');
      void loadGraph();
    },
    [refreshVaults, loadGraph],
  );

  // "Compile new" scope is implied by the active tab: Project → local,
  // Global → global.
  const compileScope: VaultScope = view === 'project' ? 'local' : 'global';
  // Existing names in the modal's scope — used only to decide whether a
  // typed name is really new (governs cancel-cleanup).
  const existingNamesInScope = useMemo(() => {
    if (!addModal) return [];
    return [...projectVaults, ...globalVaults]
      .filter((e) => e.scope === addModal.scope)
      .map((e) => e.name);
  }, [addModal, projectVaults, globalVaults]);

  return (
    <>
      <div
        className="vault-manager"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="vault-manager__panel"
          role="dialog"
          aria-label="Manage vaults"
        >
          <div className="panel-header">
            <div className="vault-manager__title">
              <h3>Vaults</h3>
              <button
                type="button"
                className="vault-drawer__compile-btn"
                onClick={() => setAddModal({ scope: compileScope })}
              >
                + Compile new
              </button>
            </div>
            <button type="button" className="close-btn" onClick={onClose}>
              &times;
            </button>
          </div>

          <div className="vault-drawer__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'project'}
              className={`vault-drawer__tab${view === 'project' ? ' vault-drawer__tab--active' : ''}`}
              onClick={() => setView('project')}
            >
              Project ({projectVaults.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'global'}
              className={`vault-drawer__tab${view === 'global' ? ' vault-drawer__tab--active' : ''}`}
              onClick={() => setView('global')}
            >
              Global ({globalVaults.length})
            </button>
          </div>

          <div className="vault-manager__body">
            {entries.length === 0 ? (
              <div className="vault-drawer__empty">
                {view === 'project'
                  ? 'No vaults in this project — compile files or attach a global vault.'
                  : 'No global vaults on this machine.'}
              </div>
            ) : (
              <div className="vault-drawer__list">
                {entries.map((entry) => (
                  <VaultRow
                    key={`${entry.scope}::${entry.name}`}
                    entry={entry}
                    view={view}
                    busy={busy === entry.name}
                    onDelete={() => void handleDeleteVault(entry)}
                    onAttach={() => void handleAttachGlobal(entry.name)}
                    onDetach={() => void handleDetachGlobal(entry.name)}
                    onPromote={() => void handlePromote(entry.name)}
                    onDemote={() => void handleDemote(entry.name)}
                    onAppend={() =>
                      setAddModal({
                        scope: entry.scope,
                        appendTo: entry.name,
                      })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {addModal && (
        <AddVaultModal
          existingVaults={existingNamesInScope}
          scope={addModal.scope}
          appendTo={addModal.appendTo}
          onClose={() => setAddModal(null)}
        />
      )}
    </>
  );
}

function VaultRow({
  entry,
  view,
  busy,
  onDelete,
  onAttach,
  onDetach,
  onPromote,
  onDemote,
  onAppend,
}: {
  entry: VaultEntry;
  view: VaultView;
  busy: boolean;
  onDelete: () => void;
  onAttach: () => void;
  onDetach: () => void;
  onPromote: () => void;
  onDemote: () => void;
  onAppend: () => void;
}) {
  // Marker behavior:
  // - Every row gets an append icon (add more files into this vault).
  // - Project tab: globals get a "global" badge so they stand out next
  //   to project-local vaults, and also a detach icon (unlink from
  //   project) in addition to the trash (delete-from-disk). Locals get a
  //   promote icon (move to global).
  // - Global tab: detached globals get a small "+" to attach;
  //   attached ones get the unlink icon; every global gets a demote icon
  //   (move into this project as a local vault). Both states still expose
  //   trash so the user can delete the disk vault from this view.
  const showGlobalBadge = view === 'project' && entry.scope === 'global';
  const showPromoteButton = view === 'project' && entry.scope === 'local';
  const showDemoteButton = view === 'global';
  const showAttachButton = view === 'global' && !entry.attached;
  const showDetachIcon =
    (view === 'project' && entry.scope === 'global') ||
    (view === 'global' && entry.attached);

  return (
    <div className="vault-drawer__list-row">
      <span className="vault-drawer__list-item vault-drawer__list-item--static">
        <span className="vault-drawer__list-item-name">{entry.name}</span>
        {showGlobalBadge && (
          <span className="vault-drawer__badge vault-drawer__badge--global">
            global
          </span>
        )}
      </span>
      <button
        type="button"
        className="vault-drawer__icon-btn"
        onClick={onAppend}
        disabled={busy}
        title={`Add more files to ${entry.name}`}
        aria-label={`Append files to ${entry.name}`}
      >
        <AppendIcon />
      </button>
      {showPromoteButton && (
        <button
          type="button"
          className="vault-drawer__icon-btn"
          onClick={onPromote}
          disabled={busy}
          title={`Promote ${entry.name} to a global vault`}
          aria-label={`Promote ${entry.name} to global`}
        >
          {busy ? '…' : <PromoteIcon />}
        </button>
      )}
      {showDemoteButton && (
        <button
          type="button"
          className="vault-drawer__icon-btn"
          onClick={onDemote}
          disabled={busy}
          title={`Demote ${entry.name} to a local vault in this project`}
          aria-label={`Demote ${entry.name} to local`}
        >
          {busy ? '…' : <DemoteIcon />}
        </button>
      )}
      {showAttachButton && (
        <button
          type="button"
          className="vault-drawer__inline-btn vault-drawer__inline-btn--icon"
          onClick={onAttach}
          disabled={busy}
          title={`Add ${entry.name} to this project's graph`}
          aria-label={`Add ${entry.name} to project`}
        >
          {busy ? '…' : '+'}
        </button>
      )}
      {showDetachIcon && (
        <button
          type="button"
          className="vault-drawer__delete-btn"
          onClick={onDetach}
          disabled={busy}
          title={`Remove ${entry.name} from this project (disk vault stays)`}
          aria-label={`Detach ${entry.name} from project`}
        >
          <DetachIcon />
        </button>
      )}
      <button
        type="button"
        className="vault-drawer__delete-btn"
        onClick={onDelete}
        disabled={busy}
        title={`Delete ${entry.name} from disk`}
        aria-label={`Delete ${entry.name} from disk`}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function AppendIcon() {
  // File with a plus — "add more documents to this vault".
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function PromoteIcon() {
  // Upward arrow into a tray — "move up to the global scope".
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function DemoteIcon() {
  // Downward arrow — "move down into this project (local scope)".
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14" />
      <path d="M5 12l7 7 7-7" />
    </svg>
  );
}

function DetachIcon() {
  // Broken-link glyph — communicates "remove from graph" without
  // suggesting destructive disk delete.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 17H7a5 5 0 0 1 0-10h2" />
      <path d="M15 7h2a5 5 0 0 1 4 8" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}
