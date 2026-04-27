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

import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Signature for the drag-start handler returned by the resize hooks. The
 * second argument is an optional cursor override — used by corner handles to
 * force `nwse-resize` / `nesw-resize` on the body so the cursor reads
 * diagonal while the drag is in flight, instead of defaulting to the
 * hook's primary-axis cursor.
 */
export type PanelResizeMouseDown = (
  e: React.MouseEvent,
  cursorOverride?: string,
) => void;

interface UseResizablePanelOptions {
  /** localStorage key for persisting width */
  storageKey: string;
  /** Default width when nothing is stored */
  defaultWidth: number;
  /** Minimum allowed width */
  minWidth: number;
  /** Maximum allowed width */
  maxWidth: number;
  /** Which side of the panel the handle is on — determines drag direction */
  side: 'left' | 'right';
  /** Ref to the panel element being resized (so mousemove can mutate its
   * `style.width` directly without walking the DOM). */
  panelRef: RefObject<HTMLElement | null>;
}

/**
 * Horizontal resize. During a drag, the panel's `style.width` is updated
 * directly via the supplied ref so mousemove doesn't trigger a React
 * re-render of the panel's subtree — matters a lot on panels with heavy
 * children (Discover's virtualized tree, filter lists). The final width is
 * committed back to React state on mouseup so it persists across re-renders
 * and makes it into localStorage.
 */
export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  side,
  panelRef,
}: UseResizablePanelOptions): {
  width: number;
  handleMouseDown: PanelResizeMouseDown;
} {
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth)
        return parsed;
    }
    return defaultWidth;
  });

  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = useCallback<PanelResizeMouseDown>(
    (e, cursorOverride) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      // Anchor the drag to whatever width the panel is ACTUALLY rendering —
      // if a `max-width` CSS clamp has pinned the panel smaller than the
      // stored React state (e.g. the viewport shrank since last drag), this
      // keeps the drag feeling continuous with what's on screen.
      const rendered = panelRef.current?.getBoundingClientRect().width;
      startWidth.current = rendered ? Math.round(rendered) : width;
      document.body.style.cursor = cursorOverride ?? 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, panelRef],
  );

  useEffect(() => {
    let pending: number | null = null;
    let rafId: number | null = null;

    const flush = () => {
      rafId = null;
      if (pending != null && panelRef.current) {
        panelRef.current.style.width = `${pending}px`;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - startX.current;
      const newWidth =
        side === 'right'
          ? startWidth.current + delta
          : startWidth.current - delta;
      pending = Math.max(minWidth, Math.min(maxWidth, newWidth));
      if (rafId == null) rafId = requestAnimationFrame(flush);
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pending != null) {
        setWidth(pending);
        pending = null;
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [minWidth, maxWidth, side, panelRef]);

  // Persist to localStorage on change (only fires on mouseup commit)
  useEffect(() => {
    localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  // Belt-and-braces auto-shrink: when the parent's width changes, force the
  // panel's inline `style.width` down to whatever the parent can actually
  // accommodate. CSS `max-width: 100%` should already do this, but
  // consumers (e.g. insight-ui) sometimes wrap the panel in a containing
  // block that doesn't propagate, so this guarantees the right edge handle
  // is always reachable.
  useEffect(() => {
    const panel = panelRef.current;
    const parent = panel?.parentElement;
    if (!panel || !parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const available = parent.clientWidth;
      if (available > 0 && panel.offsetWidth > available) {
        panel.style.width = `${available}px`;
      } else if (!isDragging.current) {
        // Restore React state width if there's room again (drag also writes
        // to inline style, so don't clobber it mid-drag).
        panel.style.width = `${width}px`;
      }
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [panelRef, width]);

  return { width, handleMouseDown };
}

interface UseResizablePanelHeightOptions {
  /** localStorage key for persisting height */
  storageKey: string;
  /** Minimum allowed height */
  minHeight: number;
  /** Maximum allowed height */
  maxHeight: number;
  /** Which edge of the panel the handle sits on — determines drag direction */
  side: 'top' | 'bottom';
  /** Ref to the panel element being resized. */
  panelRef: RefObject<HTMLElement | null>;
}

/**
 * Vertical companion to `useResizablePanel`. Returns `null` until the user
 * has dragged at least once, so callers can keep whatever height CSS gives
 * them by default (e.g. full-height or content-based) and only switch to an
 * explicit pixel height once the user opts in. Like the horizontal hook, the
 * drag applies `style.height` directly to the panel element via the supplied
 * ref so mousemove never triggers a React re-render — only mouseup commits.
 */
export function useResizablePanelHeight({
  storageKey,
  minHeight,
  maxHeight,
  side,
  panelRef,
}: UseResizablePanelHeightOptions): {
  height: number | null;
  handleMouseDown: PanelResizeMouseDown;
} {
  const [height, setHeight] = useState<number | null>(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= minHeight && parsed <= maxHeight)
        return parsed;
    }
    return null;
  });

  const isDragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const handleMouseDown = useCallback<PanelResizeMouseDown>(
    (e, cursorOverride) => {
      e.preventDefault();
      isDragging.current = true;
      startY.current = e.clientY;
      // Anchor the drag to whatever height the panel is ACTUALLY rendering —
      // this matters most before first drag when `height` is still null.
      const rendered = panelRef.current?.getBoundingClientRect().height ?? 0;
      startHeight.current = height ?? Math.round(rendered);
      document.body.style.cursor = cursorOverride ?? 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [height, panelRef],
  );

  useEffect(() => {
    let pending: number | null = null;
    let rafId: number | null = null;

    const flush = () => {
      rafId = null;
      if (pending != null && panelRef.current) {
        panelRef.current.style.height = `${pending}px`;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientY - startY.current;
      const newHeight =
        side === 'bottom'
          ? startHeight.current + delta
          : startHeight.current - delta;
      pending = Math.max(minHeight, Math.min(maxHeight, newHeight));
      if (rafId == null) rafId = requestAnimationFrame(flush);
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pending != null) {
        setHeight(pending);
        pending = null;
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [minHeight, maxHeight, side, panelRef]);

  useEffect(() => {
    if (height != null) localStorage.setItem(storageKey, String(height));
  }, [storageKey, height]);

  // Belt-and-braces auto-shrink: clamp the panel's inline `style.height`
  // down whenever the parent shrinks below it, so the bottom edge handle
  // never falls off-screen. CSS `max-height: 100%` should already do this
  // but we've seen consumers wrap the panel in containing blocks that
  // don't propagate the height correctly.
  useEffect(() => {
    const panel = panelRef.current;
    const parent = panel?.parentElement;
    if (!panel || !parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const available = parent.clientHeight;
      if (available > 0 && panel.offsetHeight > available) {
        panel.style.height = `${available}px`;
      } else if (!isDragging.current && height != null) {
        panel.style.height = `${height}px`;
      }
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [panelRef, height]);

  return { height, handleMouseDown };
}
