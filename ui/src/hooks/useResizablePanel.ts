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
}

/**
 * Horizontal resize. During a drag, the panel's inline `style.width` is
 * updated directly on the DOM node (via the handle's parent element) so
 * mousemove doesn't trigger a React re-render of the panel's subtree — this
 * matters a lot on panels with heavy children (Discover's virtualized tree,
 * filter lists). The final width is committed back to React state on
 * mouseup so it persists across re-renders and makes it into localStorage.
 */
export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  side,
}: UseResizablePanelOptions) {
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
  const panelEl = useRef<HTMLElement | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      panelEl.current = (e.currentTarget as HTMLElement).parentElement;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  useEffect(() => {
    let pending: number | null = null;
    let rafId: number | null = null;

    const flush = () => {
      rafId = null;
      if (pending != null && panelEl.current) {
        panelEl.current.style.width = `${pending}px`;
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
      panelEl.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [minWidth, maxWidth, side]);

  // Persist to localStorage on change (only fires on mouseup commit)
  useEffect(() => {
    localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

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
}

/**
 * Vertical companion to `useResizablePanel`. Returns `null` until the user has
 * dragged at least once, so callers can keep whatever height CSS gives them
 * by default (e.g. full-height or content-based) and only switch to an
 * explicit pixel height once the user opts in. Like the horizontal hook, the
 * drag applies `style.height` directly to the panel element so mousemove
 * never triggers a React re-render — only mouseup commits to React state.
 */
export function useResizablePanelHeight({
  storageKey,
  minHeight,
  maxHeight,
  side,
}: UseResizablePanelHeightOptions) {
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
  const panelEl = useRef<HTMLElement | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startY.current = e.clientY;
      // Anchor the drag to whatever height the panel is ACTUALLY rendering —
      // this matters most before first drag when `height` is still null.
      const panel = (e.currentTarget as HTMLElement).parentElement;
      panelEl.current = panel;
      const rendered = panel?.getBoundingClientRect().height ?? 0;
      startHeight.current = height ?? Math.round(rendered);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [height],
  );

  useEffect(() => {
    let pending: number | null = null;
    let rafId: number | null = null;

    const flush = () => {
      rafId = null;
      if (pending != null && panelEl.current) {
        panelEl.current.style.height = `${pending}px`;
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
      panelEl.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [minHeight, maxHeight, side]);

  useEffect(() => {
    if (height != null) localStorage.setItem(storageKey, String(height));
  }, [storageKey, height]);

  return { height, handleMouseDown };
}
