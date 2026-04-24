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

const CORNER_SIDES: readonly CornerSide[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

/**
 * Shared drag strip for every resizable panel. Pair with `useResizablePanel`
 * (left/right) or `useResizablePanelHeight` (top/bottom) and feed that hook's
 * `handleMouseDown` straight through. For corners, compose both hooks'
 * mousedowns into one handler so the drag resizes both axes simultaneously.
 *
 * A faint bar is always visible so users can discover the handle without
 * hovering first.
 */
export default function PanelResizeHandle({
  side,
  onMouseDown,
  'aria-label': ariaLabel = 'Resize panel',
}: PanelResizeHandleProps) {
  const isCorner = (CORNER_SIDES as readonly string[]).includes(side);
  const orientation =
    side === 'top' || side === 'bottom' ? 'horizontal' : 'vertical';
  return (
    <div
      className={`ot-panel-resize-handle ot-panel-resize-handle--${side}`}
      onMouseDown={onMouseDown}
      role="separator"
      aria-label={ariaLabel}
      aria-orientation={isCorner ? undefined : orientation}
    />
  );
}
