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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteVault,
  getPageMarkdown,
  getVault,
  listVaults,
} from '../../wiki/client';
import type { VaultDetail, VaultPageMeta } from '../../wiki/types';
import { WikiMarkdown } from './WikiMarkdown';
import { AddVaultModal } from './AddVaultModal';
import './wiki.css';

interface Props {
  onClose: () => void;
}

export function VaultBrowser({ onClose }: Props) {
  const [vaults, setVaults] = useState<string[]>([]);
  const [activeVault, setActiveVault] = useState<string | null>(null);
  const [vaultData, setVaultData] = useState<VaultDetail | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [pageBody, setPageBody] = useState<string>('');
  const [showAdd, setShowAdd] = useState(false);

  const refreshVaults = useCallback(async () => {
    try {
      const list = await listVaults();
      setVaults(list);
      if (!activeVault && list.length > 0) {
        setActiveVault(list[0]);
      }
    } catch (e) {
      // Treat unreachable backend the same as an empty vault list — the UI
      // shows "No vaults yet" rather than a fetch error. The reason is logged
      // for debugging.
      console.warn('[VaultBrowser] listVaults failed:', e);
      setVaults([]);
    }
  }, [activeVault]);

  useEffect(() => {
    // refreshVaults is async — its setState calls run after await, but the
    // react-hooks/set-state-in-effect rule can't see through the function
    // boundary. Suppressing here is a deliberate "the work is async, trust me".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshVaults();
  }, [refreshVaults]);

  useEffect(() => {
    if (!activeVault) {
      // Synchronous clear-on-deps-change — we want vaultData and activeSlug
      // to reflect "no vault selected" immediately. The rule prefers async
      // patterns but this is the canonical way to clear derived state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVaultData(null);
      setActiveSlug(null);
      return;
    }
    let cancelled = false;
    void getVault(activeVault)
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
            name: activeVault,
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
    void getPageMarkdown(activeVault, activeSlug).then((text) => {
      if (!cancelled) setPageBody(text);
    });
    return () => {
      cancelled = true;
    };
  }, [activeVault, activeSlug]);

  const handleCompiled = useCallback(
    async (name: string) => {
      await refreshVaults();
      setActiveVault(name);
      const data = await getVault(name);
      setVaultData(data);
      if (data.pages.length > 0) setActiveSlug(data.pages[0].slug);
    },
    [refreshVaults],
  );

  const handleDeleteVault = useCallback(
    async (name: string) => {
      const ok = window.confirm(
        `Delete vault "${name}"? This removes all of its pages from disk.`,
      );
      if (!ok) return;
      try {
        await deleteVault(name);
      } catch (e) {
        console.warn('[VaultBrowser] deleteVault failed:', e);
        return;
      }
      if (activeVault === name) {
        setActiveVault(null);
        setVaultData(null);
        setActiveSlug(null);
        setPageBody('');
      }
      await refreshVaults();
    },
    [activeVault, refreshVaults],
  );

  return (
    <div className="vault-drawer">
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

      <div className="vault-drawer__body">
        <div className="vault-drawer__sidebar">
          <div className="vault-drawer__sidebar-section">
            <h4>Vaults</h4>
            {vaults.length === 0 ? (
              <div className="vault-drawer__empty">
                No vaults yet — click "Compile files" to create one.
              </div>
            ) : (
              <div className="vault-drawer__list">
                {vaults.map((v) => (
                  <div key={v} className="vault-drawer__list-row">
                    <button
                      className={`vault-drawer__list-item${v === activeVault ? ' vault-drawer__list-item--active' : ''}`}
                      onClick={() => setActiveVault(v)}
                    >
                      {v}
                    </button>
                    <button
                      type="button"
                      className="vault-drawer__delete-btn"
                      onClick={() => void handleDeleteVault(v)}
                      title={`Delete ${v}`}
                      aria-label={`Delete ${v}`}
                    >
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
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <PagesSection
            vaultData={vaultData}
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
          existingVaults={vaults}
          onClose={() => setShowAdd(false)}
          onCompiled={(name) => {
            setShowAdd(false);
            void handleCompiled(name);
          }}
        />
      )}
    </div>
  );
}

function PagesSection({
  vaultData,
  activeSlug,
  onSelect,
}: {
  vaultData: VaultDetail | null;
  activeSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  const { concepts, sourceSummaries } = useMemo(() => {
    const c: VaultPageMeta[] = [];
    const s: VaultPageMeta[] = [];
    for (const p of vaultData?.pages ?? []) {
      // Legacy "source" value behaves the same as the new "source_summary".
      const isSummary = p.kind === 'source_summary' || p.kind === 'source';
      (isSummary ? s : c).push(p);
    }
    return { concepts: c, sourceSummaries: s };
  }, [vaultData]);

  if (!vaultData || vaultData.pages.length === 0) {
    return (
      <div className="vault-drawer__sidebar-section">
        <h4>Pages</h4>
        <div className="vault-drawer__empty">No pages yet.</div>
      </div>
    );
  }

  return (
    <div className="vault-drawer__sidebar-section vault-drawer__sidebar-section--pages">
      {concepts.length > 0 && (
        <>
          <h4>Concepts</h4>
          <div className="vault-drawer__list">
            {concepts.map((p) => (
              <PageListItem
                key={p.slug}
                page={p}
                active={p.slug === activeSlug}
                onSelect={onSelect}
              />
            ))}
          </div>
        </>
      )}
      {sourceSummaries.length > 0 && (
        <>
          <h4>Source summaries</h4>
          <div className="vault-drawer__list">
            {sourceSummaries.map((p) => (
              <PageListItem
                key={p.slug}
                page={p}
                active={p.slug === activeSlug}
                onSelect={onSelect}
              />
            ))}
          </div>
        </>
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
  // Source-summary pages have "Source Summary: " (or legacy "Source: ") in
  // the title; the section header already conveys that, so strip the prefix
  // for a cleaner row.
  const isSummary = page.kind === 'source_summary' || page.kind === 'source';
  let display = page.title;
  if (isSummary) {
    if (page.title.startsWith('Source Summary: ')) {
      display = page.title.slice('Source Summary: '.length);
    } else if (page.title.startsWith('Source: ')) {
      display = page.title.slice('Source: '.length);
    }
  }
  return (
    <button
      className={`vault-drawer__list-item${active ? ' vault-drawer__list-item--active' : ''}`}
      onClick={() => onSelect(page.slug)}
      title={page.one_line_summary}
    >
      {display}
      {page.one_line_summary && (
        <span className="vault-drawer__list-item-summary">
          {page.one_line_summary}
        </span>
      )}
    </button>
  );
}
