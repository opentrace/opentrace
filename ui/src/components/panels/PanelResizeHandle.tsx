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

import { useCallback, useEffect, useRef } from 'react';
import './PanelResizeHandle.css';

type EdgeSide = 'left' | 'right' | 'top' | 'bottom';
type CornerSide = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type PanelResizeHandleSide = EdgeSide | CornerSide;

interface PanelResizeHandleProps {
  /** Which edge (or corner) of the parent panel the handle sits on. */
  side: PanelResizeHandleSide;
  onMouseDown: (e: React.MouseEvent) => void;
  /** Optional a11y label. */
  'aria-label'?: string;
}

const CORNER_CLASS: Record<CornerSide, string> = {
  'top-left': 'ot-panel--corner-active-tl',
  'top-right': 'ot-panel--corner-active-tr',
  'bottom-left': 'ot-panel--corner-active-bl',
  'bottom-right': 'ot-panel--corner-active-br',
};

function isCorner(side: PanelResizeHandleSide): side is CornerSide {
  return side in CORNER_CLASS;
}

/**
 * Shared drag strip for every resizable panel. For corners we additionally
 * tag the parent panel with a marker class while the corner is hovered or
 * pressed — the class lets sibling edge bars cascade-highlight without
 * relying on `:has()` quirks (which we've seen flake under specific stacking
 * contexts). The release-listener is registered on `window` so the class
 * still gets removed when the user drags off the panel.
 */
export default function PanelResizeHandle({
  side,
  onMouseDown,
  'aria-label': ariaLabel = 'Resize panel',
}: PanelResizeHandleProps) {
  const corner = isCorner(side);
  const orientation =
    side === 'top' || side === 'bottom' ? 'horizontal' : 'vertical';
  const ref = useRef<HTMLDivElement>(null);
  const releaseRef = useRef<(() => void) | null>(null);

  const tagPanel = useCallback(() => {
    if (!corner) return;
    const panel = ref.current?.parentElement;
    if (!panel) return;
    const cls = CORNER_CLASS[side as CornerSide];
    panel.classList.add(cls);
    // Pull the actual panel's border-radius so the arc curve matches
    // the panel's outer rounded edge, regardless of theme/consumer.
    const cs = window.getComputedStyle(panel);
    const radius =
      side === 'top-left'
        ? cs.borderTopLeftRadius
        : side === 'top-right'
          ? cs.borderTopRightRadius
          : side === 'bottom-left'
            ? cs.borderBottomLeftRadius
            : cs.borderBottomRightRadius;
    if (radius && radius !== '0px') {
      // Set on the panel so both the corner handle's arc AND the adjacent
      // edge bars (siblings) pick up the same radius value.
      panel.style.setProperty('--ot-panel-corner-radius', radius);
    }
  }, [corner, side]);

  const untagPanel = useCallback(() => {
    if (!corner) return;
    const panel = ref.current?.parentElement;
    if (!panel) return;
    panel.classList.remove(CORNER_CLASS[side as CornerSide]);
  }, [corner, side]);

  const handleMouseEnter = useCallback(() => {
    tagPanel();
  }, [tagPanel]);

  const handleMouseLeave = useCallback(() => {
    // Don't strip the class while a drag is in progress — wait for mouseup.
    if (!releaseRef.current) untagPanel();
  }, [untagPanel]);

  const wrappedMouseDown = useCallback(
    (e: React.MouseEvent) => {
      onMouseDown(e);
      if (!corner) return;
      tagPanel();
      const onRelease = () => {
        untagPanel();
        window.removeEventListener('mouseup', onRelease);
        releaseRef.current = null;
      };
      releaseRef.current = onRelease;
      window.addEventListener('mouseup', onRelease);
    },
    [onMouseDown, corner, tagPanel, untagPanel],
  );

  // Clean up any pending mouseup listener if the handle unmounts mid-drag.
  useEffect(() => {
    return () => {
      if (releaseRef.current) {
        window.removeEventListener('mouseup', releaseRef.current);
        releaseRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`ot-panel-resize-handle ot-panel-resize-handle--${side}`}
      onMouseDown={wrappedMouseDown}
      onMouseEnter={corner ? handleMouseEnter : undefined}
      onMouseLeave={corner ? handleMouseLeave : undefined}
      role="separator"
      aria-label={ariaLabel}
      aria-orientation={corner ? undefined : orientation}
    />
  );
}
