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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphToolbarProps } from './types';
import GraphBadge from './GraphBadge';
import './GraphToolbar.css';

export default function GraphToolbar({
  logo,
  searchQuery,
  onSearchQueryChange,
  onSearch,
  onReset,
  searchDisabled,
  showResetButton,
  hops,
  onHopsChange,
  maxHops = 5,
  nodeCount,
  edgeCount,
  totalNodes,
  totalEdges,
  mobilePanelTabs,
  onMobilePanelTab,
  actions,
  className,
}: GraphToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);

  // Close burger menu on click-outside or Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (navRef.current?.contains(e.target as Node)) return;
      if (burgerRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [menuOpen]);

  // Auto-close mobile menu when a button/link inside the nav is clicked
  const handleNavClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Walk up to find if a <button> or <a> was clicked (but not the search input)
    const clickable = target.closest('button, a');
    if (
      clickable &&
      !clickable.classList.contains('ot-clear-search') &&
      !clickable.classList.contains('ot-search-btn')
    ) {
      setMenuOpen(false);
    }
  }, []);

  const visibleTabs = mobilePanelTabs?.filter((t) => t.visible !== false);

  return (
    <header className={`ot-toolbar${className ? ` ${className}` : ''}`}>
      {logo}
      <button
        type="button"
        className="ot-burger-btn"
        ref={burgerRef}
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Toggle menu"
        aria-expanded={menuOpen}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {menuOpen ? (
            <>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </>
          ) : (
            <>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </>
          )}
        </svg>
      </button>
      <nav
        className={`ot-toolbar-nav${menuOpen ? ' open' : ''}`}
        ref={navRef}
        onClick={handleNavClick}
      >
        {visibleTabs?.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className="ot-mobile-panel-btn"
            onClick={() => onMobilePanelTab?.(tab.key)}
          >
            {tab.icon}
            <span className="ot-menu-label">{tab.label}</span>
          </button>
        ))}
        {visibleTabs && visibleTabs.length > 0 && (
          <div className="ot-menu-divider" />
        )}
        <div className="ot-search-container">
          <input
            type="text"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            className="ot-search-input"
          />
          <div className="ot-search-params">
            <label htmlFor="ot-hops-input">Hops:</label>
            <input
              id="ot-hops-input"
              type="number"
              min="0"
              max={maxHops}
              value={hops}
              onChange={(e) =>
                onHopsChange(
                  Math.min(
                    maxHops,
                    Math.max(0, parseInt(e.target.value) || 0),
                  ),
                )
              }
              className="ot-hops-input"
              title={`Number of connection hops to include (max ${maxHops})`}
            />
          </div>
          <div className="ot-search-actions">
            {searchQuery && (
              <button
                className="ot-clear-search"
                onClick={onReset}
                title="Clear search"
              >
                &times;
              </button>
            )}
            <button
              className="ot-search-btn"
              onClick={onSearch}
              title="Query API and rerender"
              disabled={searchDisabled}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
          </div>
        </div>
        {showResetButton && (
          <button className="ot-reset-btn" onClick={onReset}>
            Show All
          </button>
        )}
        <GraphBadge
          nodeCount={nodeCount}
          edgeCount={edgeCount}
          totalNodes={totalNodes}
          totalEdges={totalEdges}
        />
        {actions}
      </nav>
    </header>
  );
}
