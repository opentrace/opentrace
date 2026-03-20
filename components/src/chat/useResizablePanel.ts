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

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - startX.current;
      // For a right-side handle, dragging right = wider; for left-side, dragging left = wider
      const newWidth =
        side === 'right'
          ? startWidth.current + delta
          : startWidth.current - delta;
      const clamped = Math.max(minWidth, Math.min(maxWidth, newWidth));
      setWidth(clamped);
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [minWidth, maxWidth, side]);

  // Persist to localStorage on change (debounced via the mouseup ending the drag)
  useEffect(() => {
    localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  return { width, handleMouseDown };
}
