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
import { PanelResizeHandle } from '@opentrace/components';
import {
  attachVault,
  deleteVault,
  detachVault,
  getPageMarkdown,
  getVault,
  listVaults,
  type VaultView,
} from '../../wiki/client';
import type {
  VaultDetail,
  VaultEntry,
  VaultPageMeta,
  VaultScope,
} from '../../wiki/types';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { WikiMarkdown } from './WikiMarkdown';
import { AddVaultModal } from './AddVaultModal';
import { useGraph } from '../../providers/GraphDataProvider';
import './wiki.css';

interface Props {
  onClose: () => void;
}

interface ActiveVault {
  name: string;
  scope: VaultScope;
}

const sameVault = (a: ActiveVault | null, b: ActiveVault | null): boolean =>
  a !== null && b !== null && a.name === b.name && a.scope === b.scope;

export function VaultBrowser({ onClose }: Props) {
  const [view, setView] = useState<VaultView>('project');
  const [projectVaults, setProjectVaults] = useState<VaultEntry[]>([]);
  const [globalVaults, setGlobalVaults] = useState<VaultEntry[]>([]);
  const [activeVault, setActiveVault] = useState<ActiveVault | null>(null);
  const [vaultData, setVaultData] = useState<VaultDetail | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [pageBody, setPageBody] = useState<string>('');
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { loadGraph } = useGraph();

  const panelRef = useRef<HTMLDivElement>(null);
  const { width: panelWidth, handleMouseDown } = useResizablePanel({
    storageKey: 'ot_vault_drawer_width',
    defaultWidth: 640,
    minWidth: 320,
    maxWidth: 1200,
    side: 'right',
    panelRef,
  });

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
      console.warn('[VaultBrowser] listVaults failed:', e);
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

  // Auto-select the first entry of the active tab when nothing is selected,
  // or when the current selection isn't visible under this tab.
  useEffect(() => {
    if (entries.length === 0) {
      if (activeVault !== null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setActiveVault(null);
      }
      return;
    }
    const stillVisible =
      activeVault &&
      entries.some(
        (e) => e.name === activeVault.name && e.scope === activeVault.scope,
      );
    if (!stillVisible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveVault({ name: entries[0].name, scope: entries[0].scope });
    }
  }, [entries, activeVault]);

  useEffect(() => {
    if (!activeVault) {
      // Synchronous clear-on-deps-change — we want vaultData and activeSlug
      // to reflect "no vault selected" immediately.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVaultData(null);
      setActiveSlug(null);
      return;
    }
    let cancelled = false;
    void getVault(activeVault.name, activeVault.scope)
      .then((d) => {
        if (cancelled) return;
        setVaultData(d);
        setActiveSlug((cur) =>
          cur && d.pages.some((p) => p.slug === cur)
            ? cur
            : (d.pages[0]?.slug ?? null),
        );
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn('[VaultBrowser] getVault failed:', e);
          setVaultData({
            name: activeVault.name,
            last_compiled_at: null,
            pages: [],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeVault]);

  useEffect(() => {
    if (!activeVault || !activeSlug) {
      // Same pattern: clear derived state when its inputs go away.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPageBody('');
      return;
    }
    let cancelled = false;
    void getPageMarkdown(activeVault.name, activeSlug, activeVault.scope)
      .then((text) => {
        if (!cancelled) setPageBody(text);
      })
      .catch((e) => {
        // Without an explicit clear, a failed fetch leaves the
        // previous page body on screen — visually identical to the
        // race condition the parent effect already guards against.
        if (!cancelled) {
          console.warn('[VaultBrowser] getPageMarkdown failed:', e);
          setPageBody('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeVault, activeSlug]);

  const handleCompiled = useCallback(
    async (name: string, scope: VaultScope) => {
      await refreshVaults();
      // Switch to the tab that will surface the new vault. A local compile
      // always lands in Project; a global compile lands in Global, and only
      // appears in Project once attached (which compile does automatically
      // for the local case but NOT for global — globals require explicit
      // attach to appear in the project's graph).
      const target: VaultView = scope === 'local' ? 'project' : 'global';
      setView(target);
      setActiveVault({ name, scope });
      const data = await getVault(name, scope);
      setVaultData(data);
      if (data.pages.length > 0) setActiveSlug(data.pages[0].slug);
      // Reload the graph so the newly-mirrored vault/page/source nodes
      // appear without a hard refresh. Server-mode is read-through; in
      // browser-mode this is a no-op against the in-browser store.
      void loadGraph();
    },
    [refreshVaults, loadGraph],
  );

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
        console.warn('[VaultBrowser] deleteVault failed:', e);
        setBusy(null);
        return;
      }
      if (sameVault(activeVault, entry)) {
        setActiveVault(null);
        setVaultData(null);
        setActiveSlug(null);
        setPageBody('');
      }
      await refreshVaults();
      setBusy(null);
      // Reload the graph so the deleted vault's nodes/edges disappear
      // without a hard refresh.
      void loadGraph();
    },
    [activeVault, refreshVaults, loadGraph],
  );

  const handleDetachGlobal = useCallback(
    async (name: string) => {
      const ok = window.confirm(
        `Remove global vault "${name}" from this project? The disk vault is preserved and will still appear in the Global tab.`,
      );
      if (!ok) return;
      setBusy(name);
      try {
        await detachVault(name);
      } catch (e) {
        console.warn('[VaultBrowser] detachVault failed:', e);
        setBusy(null);
        return;
      }
      if (
        activeVault &&
        activeVault.name === name &&
        activeVault.scope === 'global'
      ) {
        setActiveVault(null);
        setVaultData(null);
        setActiveSlug(null);
        setPageBody('');
      }
      await refreshVaults();
      setBusy(null);
      void loadGraph();
    },
    [activeVault, refreshVaults, loadGraph],
  );

  const handleAttachGlobal = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        await attachVault(name);
      } catch (e) {
        console.warn('[VaultBrowser] attachVault failed:', e);
        setBusy(null);
        return;
      }
      await refreshVaults();
      setBusy(null);
      void loadGraph();
    },
    [refreshVaults, loadGraph],
  );

  // The compile scope is implied by the active tab: Project → local,
  // Global → global. Existing-vault selection in the modal is restricted
  // to vaults of the matching scope to avoid silently re-scoping a vault.
  const compileScope: VaultScope = view === 'project' ? 'local' : 'global';
  const existingForCompile = useMemo(
    () => entries.filter((e) => e.scope === compileScope).map((e) => e.name),
    [entries, compileScope],
  );

  return (
    <div
      ref={panelRef}
      className="vault-drawer"
      style={
        { '--vault-drawer-width': `${panelWidth}px` } as React.CSSProperties
      }
    >
      <PanelResizeHandle side="right" onMouseDown={handleMouseDown} />
      <div className="panel-header">
        <h3>Vaults</h3>
        <div className="panel-header-actions">
          <button
            type="button"
            className="vault-drawer__compile-btn"
            onClick={() => setShowAdd(true)}
          >
            + Compile files
          </button>
          <button type="button" className="close-btn" onClick={onClose}>
            &times;
          </button>
        </div>
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

      <div className="vault-drawer__body">
        <div className="vault-drawer__sidebar">
          <div className="vault-drawer__sidebar-section">
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
                    active={sameVault(activeVault, entry)}
                    busy={busy === entry.name}
                    onSelect={() =>
                      // Functional update preserves object identity when
                      // the user re-clicks the active vault — otherwise a
                      // new {name,scope} object retriggers the load effect
                      // and clears+refetches everything for no reason.
                      setActiveVault((cur) =>
                        cur &&
                        cur.name === entry.name &&
                        cur.scope === entry.scope
                          ? cur
                          : { name: entry.name, scope: entry.scope },
                      )
                    }
                    onDelete={() => void handleDeleteVault(entry)}
                    onAttach={() => void handleAttachGlobal(entry.name)}
                    onDetach={() => void handleDetachGlobal(entry.name)}
                  />
                ))}
              </div>
            )}
          </div>

          <PagesSection
            vaultData={vaultData}
            vaultName={activeVault?.name ?? null}
            activeSlug={activeSlug}
            onSelect={setActiveSlug}
          />
        </div>

        <div className="vault-drawer__page">
          {activeSlug && vaultData ? (
            <WikiMarkdown
              markdown={pageBody}
              pages={vaultData.pages}
              onPageClick={(slug) => setActiveSlug(slug)}
            />
          ) : (
            <div className="vault-drawer__empty">
              Select a page to view, or compile files to create one.
            </div>
          )}
        </div>
      </div>

      {showAdd && (
        <AddVaultModal
          existingVaults={existingForCompile}
          scope={compileScope}
          onClose={() => setShowAdd(false)}
          onCompiled={(name) => {
            setShowAdd(false);
            void handleCompiled(name, compileScope);
          }}
        />
      )}
    </div>
  );
}

function VaultRow({
  entry,
  view,
  active,
  busy,
  onSelect,
  onDelete,
  onAttach,
  onDetach,
}: {
  entry: VaultEntry;
  view: VaultView;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onAttach: () => void;
  onDetach: () => void;
}) {
  // Marker behavior:
  // - Project tab: globals get a "global" badge so they stand out next
  //   to project-local vaults, and also a detach icon (unlink from
  //   project) in addition to the trash (delete-from-disk).
  // - Global tab: detached globals get a small "+" to attach;
  //   attached ones get the unlink icon. Both states still expose
  //   trash so the user can delete the disk vault from this view.
  const showGlobalBadge = view === 'project' && entry.scope === 'global';
  const showAttachButton = view === 'global' && !entry.attached;
  const showDetachIcon =
    (view === 'project' && entry.scope === 'global') ||
    (view === 'global' && entry.attached);

  return (
    <div className="vault-drawer__list-row">
      <button
        className={`vault-drawer__list-item${active ? ' vault-drawer__list-item--active' : ''}`}
        onClick={onSelect}
      >
        <span className="vault-drawer__list-item-name">{entry.name}</span>
        {showGlobalBadge && (
          <span className="vault-drawer__badge vault-drawer__badge--global">
            global
          </span>
        )}
      </button>
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

type PageKindTab = 'concepts' | 'sources';

function PagesSection({
  vaultData,
  vaultName,
  activeSlug,
  onSelect,
}: {
  vaultData: VaultDetail | null;
  vaultName: string | null;
  activeSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  const { concepts, sourceSummaries } = useMemo(() => {
    const c: VaultPageMeta[] = [];
    const s: VaultPageMeta[] = [];
    for (const p of vaultData?.pages ?? []) {
      // Legacy "source" / "source_summary" values behave the same as the
      // new "file_summary".
      const isSummary =
        p.kind === 'file_summary' ||
        p.kind === 'source_summary' ||
        p.kind === 'source';
      (isSummary ? s : c).push(p);
    }
    return { concepts: c, sourceSummaries: s };
  }, [vaultData]);

  const [tab, setTab] = useState<PageKindTab>('concepts');

  // Keep the active sub-tab in sync with which kind the currently
  // selected page belongs to — so jumping between vaults (or following a
  // wiki-link from a concept body to a file summary) auto-switches the
  // visible list without forcing the user to click the tab themselves.
  const activeInSources = useMemo(
    () =>
      activeSlug ? sourceSummaries.some((p) => p.slug === activeSlug) : false,
    [activeSlug, sourceSummaries],
  );
  const activeInConcepts = useMemo(
    () => (activeSlug ? concepts.some((p) => p.slug === activeSlug) : false),
    [activeSlug, concepts],
  );
  useEffect(() => {
    if (activeInSources) setTab('sources');
    else if (activeInConcepts) setTab('concepts');
  }, [activeInSources, activeInConcepts]);

  if (!vaultData || vaultData.pages.length === 0) {
    return (
      <div className="vault-drawer__sidebar-section vault-drawer__sidebar-section--pages">
        <h4 className="vault-drawer__pages-header">
          {vaultName ? (
            <>
              Pages in{' '}
              <span className="vault-drawer__pages-header-vault">
                {vaultName}
              </span>
            </>
          ) : (
            'Pages'
          )}
        </h4>
        <div className="vault-drawer__empty">
          {vaultName ? 'No pages in this vault yet.' : 'No vault selected.'}
        </div>
      </div>
    );
  }

  const list = tab === 'concepts' ? concepts : sourceSummaries;

  return (
    <div className="vault-drawer__sidebar-section vault-drawer__sidebar-section--pages">
      <h4 className="vault-drawer__pages-header">
        Pages in{' '}
        <span className="vault-drawer__pages-header-vault">{vaultName}</span>
      </h4>
      <div className="vault-drawer__subtabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'concepts'}
          className={`vault-drawer__subtab${tab === 'concepts' ? ' vault-drawer__subtab--active' : ''}`}
          onClick={() => setTab('concepts')}
        >
          Concepts ({concepts.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sources'}
          className={`vault-drawer__subtab${tab === 'sources' ? ' vault-drawer__subtab--active' : ''}`}
          onClick={() => setTab('sources')}
        >
          File summaries ({sourceSummaries.length})
        </button>
      </div>
      {list.length === 0 ? (
        <div className="vault-drawer__empty">
          {tab === 'concepts'
            ? 'No concept pages yet.'
            : 'No file summaries yet.'}
        </div>
      ) : (
        <div className="vault-drawer__list">
          {list.map((p) => (
            <PageListItem
              key={p.slug}
              page={p}
              active={p.slug === activeSlug}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PageListItem({
  page,
  active,
  onSelect,
}: {
  page: VaultPageMeta;
  active: boolean;
  onSelect: (slug: string) => void;
}) {
  return (
    <button
      className={`vault-drawer__list-item${active ? ' vault-drawer__list-item--active' : ''}`}
      onClick={() => onSelect(page.slug)}
      title={page.one_line_summary}
    >
      {page.title}
      {page.one_line_summary && (
        <span className="vault-drawer__list-item-summary">
          {page.one_line_summary}
        </span>
      )}
    </button>
  );
}
