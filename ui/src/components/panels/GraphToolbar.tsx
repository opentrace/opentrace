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
import type { GraphToolbarProps, SearchSuggestion } from './types';
import GraphBadge from './GraphBadge';
import './GraphToolbar.css';

const MAX_SUGGESTIONS = 8;

const CATEGORY_LABELS: Record<SearchSuggestion['category'], string> = {
  name: 'Nodes',
  community: 'Communities',
};

/** Strip spaces for fuzzy matching ("read me" ↔ "readme") */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

function matchesSuggestion(label: string, query: string): boolean {
  const lower = label.toLowerCase();
  const lowerQ = query.toLowerCase();
  // Exact substring match (case-insensitive)
  if (lower.includes(lowerQ)) return true;
  // Space-stripped match ("read me" ↔ "readme.md")
  return normalize(label).includes(normalize(query));
}

function filterSuggestions(
  suggestions: SearchSuggestion[],
  query: string,
): SearchSuggestion[] {
  const catOrder: SearchSuggestion['category'][] = ['community', 'name'];

  if (!query.trim()) {
    // No query: show a sample sorted by category (communities first, then nodes)
    const sorted = [...suggestions].sort((a, b) => {
      const aCat = catOrder.indexOf(a.category);
      const bCat = catOrder.indexOf(b.category);
      if (aCat !== bCat) return aCat - bCat;
      return a.label.localeCompare(b.label);
    });
    return sorted.slice(0, MAX_SUGGESTIONS);
  }

  const matched = suggestions.filter((s) =>
    matchesSuggestion(s.label, query.trim()),
  );
  const normQ = normalize(query);
  // When filtering, prioritise names over communities
  const filterCatOrder: SearchSuggestion['category'][] = ['name', 'community'];
  matched.sort((a, b) => {
    const aNorm = normalize(a.label);
    const bNorm = normalize(b.label);
    const aPrefix = aNorm.startsWith(normQ) ? 0 : 1;
    const bPrefix = bNorm.startsWith(normQ) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    const aCat = filterCatOrder.indexOf(a.category);
    const bCat = filterCatOrder.indexOf(b.category);
    if (aCat !== bCat) return aCat - bCat;
    return a.label.localeCompare(b.label);
  });
  return matched.slice(0, MAX_SUGGESTIONS);
}

export default function GraphToolbar({
  logo,
  searchQuery,
  onSearchQueryChange,
  onSearch,
  onReset,
  searchDisabled,
  showResetButton,
  searchSuggestions,
  onSuggestionSelect,
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
  persistentActions,
  className,
}: GraphToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const navRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);

  const suggestions = useMemo(
    () => filterSuggestions(searchSuggestions ?? [], searchQuery),
    [searchSuggestions, searchQuery],
  );

  // Close autocomplete on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('.ot-search-container')) {
        setShowAutocomplete(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectSuggestion = useCallback(
    (suggestion: SearchSuggestion) => {
      onSearchQueryChange(suggestion.label);
      setShowAutocomplete(false);
      onSuggestionSelect?.(suggestion);
    },
    [onSearchQueryChange, onSuggestionSelect],
  );

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
    if (!clickable) return;
    // Don't close the menu for search controls or sub-menu toggle buttons
    if (
      clickable.classList.contains('ot-clear-search') ||
      clickable.classList.contains('ot-search-btn') ||
      clickable.classList.contains('ot-submenu-toggle')
    ) {
      return;
    }
    setMenuOpen(false);
  }, []);

  const visibleTabs = mobilePanelTabs?.filter((t) => t.visible !== false);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showAutocomplete && suggestions.length > 0) {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setActiveIndex((prev) =>
              prev < suggestions.length - 1 ? prev + 1 : 0,
            );
            return;
          case 'ArrowUp':
            e.preventDefault();
            setActiveIndex((prev) =>
              prev > 0 ? prev - 1 : suggestions.length - 1,
            );
            return;
          case 'Escape':
            e.preventDefault();
            setShowAutocomplete(false);
            return;
          case 'Enter':
            if (activeIndex >= 0 && activeIndex < suggestions.length) {
              e.preventDefault();
              selectSuggestion(suggestions[activeIndex]);
              return;
            }
            break;
        }
      }
      if (e.key === 'Enter') onSearch();
    },
    [showAutocomplete, suggestions, activeIndex, selectSuggestion, onSearch],
  );

  const searchMarkup = (id: string) => {
    const dropdownId = `ot-search-autocomplete-${id}`;
    return (
      <div className="ot-search-container">
        <input
          type="text"
          placeholder="Search nodes..."
          value={searchQuery}
          onChange={(e) => {
            onSearchQueryChange(e.target.value);
            setShowAutocomplete(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setShowAutocomplete(true)}
          onKeyDown={handleSearchKeyDown}
          className="ot-search-input"
          role="combobox"
          aria-expanded={showAutocomplete && suggestions.length > 0}
          aria-autocomplete="list"
          aria-controls={dropdownId}
          autoComplete="off"
        />
        <div className="ot-search-params">
          <label htmlFor={`ot-hops-input-${id}`}>Hops:</label>
          <input
            id={`ot-hops-input-${id}`}
            type="number"
            min="0"
            max={maxHops}
            value={hops}
            onChange={(e) =>
              onHopsChange(
                Math.min(maxHops, Math.max(0, parseInt(e.target.value) || 0)),
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
              onClick={() => {
                onReset();
                setShowAutocomplete(false);
              }}
              title="Clear search"
            >
              &times;
            </button>
          )}
          <button
            className="ot-search-btn"
            onClick={() => {
              onSearch();
              setShowAutocomplete(false);
            }}
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
        {showAutocomplete && suggestions.length > 0 && (
          <div
            id={dropdownId}
            className="ot-search-autocomplete"
            role="listbox"
          >
            {suggestions.map((suggestion, idx) => {
              const prevCategory =
                idx > 0 ? suggestions[idx - 1].category : null;
              const showHeader = suggestion.category !== prevCategory;
              return (
                <div key={`${suggestion.category}-${suggestion.label}`}>
                  {showHeader && (
                    <div className="ot-ac-header">
                      {CATEGORY_LABELS[suggestion.category]}
                    </div>
                  )}
                  <button
                    className={`ot-ac-item${idx === activeIndex ? ' ot-ac-item--active' : ''}`}
                    role="option"
                    aria-selected={idx === activeIndex}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSuggestion(suggestion);
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    {suggestion.color && (
                      <span
                        className="ot-ac-dot"
                        style={{ backgroundColor: suggestion.color }}
                      />
                    )}
                    <span className="ot-ac-label">{suggestion.label}</span>
                    {suggestion.communityLabel ? (
                      <span
                        className="ot-ac-community"
                        style={{ color: suggestion.communityColor }}
                      >
                        {suggestion.communityLabel}
                      </span>
                    ) : (
                      <span className="ot-ac-category">
                        {suggestion.category}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <header className={`ot-toolbar${className ? ` ${className}` : ''}`}>
      {logo}
      <div className="ot-search-tablet">{searchMarkup('tablet')}</div>
      {persistentActions && (
        <div className="ot-persistent-mobile">{persistentActions}</div>
      )}
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
        <div className="ot-search-nav">{searchMarkup('nav')}</div>
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
        {persistentActions && (
          <div className="ot-persistent-desktop">{persistentActions}</div>
        )}
        {actions}
      </nav>
    </header>
  );
}
