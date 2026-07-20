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

import { useEffect, useRef, useState } from 'react';
import { PresetIcon } from '../components/panels/PresetIcon';
import type { GraphPreset } from '../components/config/graphPresets';

interface ViewPresetBarProps {
  presets: GraphPreset[];
  /** Currently-applied preset id, or null/'custom' when hand-tweaked. */
  activePresetId: string | null;
  onSelectPreset: (id: string) => void;
  /** Width (px) of an open right-hand overlay panel (chat / help). The graph
   *  viewport is full-width and these panels float over its right edge, so the
   *  bar must keep this much clearance from the host's right edge or it lands
   *  UNDER the panel (the preset chips covering the chat header). 0 when none. */
  rightInset?: number;
}

/** Shape/placement ladder, compacted by MEASURED proximity, not by fixed
 *  breakpoints — and always with the chip labels visible. The bar lives IN
 *  the header row (left of the header's action buttons); when the free
 *  corridor beside the node/edge counts shrinks it compacts: row → 2×2 grid
 *  at the corner below → vertical column → a row under the whole toolbar. */
type BarMode = 'row' | 'grid' | 'column' | 'under';

/** Space the labeled row needs in the header corridor, incl. breathing room. */
const LABELED_ROW_W = 346;

interface Anchor {
  mode: BarMode;
  top: number;
  right: number;
}

export default function ViewPresetBar({
  presets,
  activePresetId,
  onSelectPreset,
  rightInset = 0,
}: ViewPresetBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<Anchor>({
    mode: 'row',
    top: 16,
    right: 12,
  });
  const measureRef = useRef<() => void>(() => {});
  // `measure` is created once (in the mount effect) but must read the LATEST
  // inset — a right panel opening/closing re-renders this component, and the
  // per-render effect below re-runs `measure` (via rAF, after this ref syncs),
  // which reads this ref. Written in an effect (not during render) so measure()
  // still sees the current value on the next scheduled pass.
  const rightInsetRef = useRef(rightInset);
  useEffect(() => {
    rightInsetRef.current = rightInset;
  }, [rightInset]);

  useEffect(() => {
    const host = barRef.current?.parentElement;
    const toolbar = host?.querySelector(':scope > header');
    if (!host || !toolbar) return;

    // Fires on size changes of the individual header pieces — some load
    // ASYNC and grow without any DOM mutation (the GitHub Star button
    // inflates when its star count arrives; the bar used to end up under
    // it because nothing re-measured). Observing each measured element
    // catches every such layout shift; re-observing is idempotent.
    const elementRo = new ResizeObserver(() => scheduleMeasure());

    const measure = () => {
      const hostBox = host.getBoundingClientRect();
      const headerBox = toolbar.getBoundingClientRect();
      const vw = window.innerWidth;

      // Visible interactive/content pieces of the header.
      const rects: DOMRect[] = [];
      for (const el of toolbar.querySelectorAll(
        'button, a, input, select, [class*="badge"], [class*="search-container"], [class*="logo"]',
      )) {
        elementRo.observe(el);
        const b = (el as HTMLElement).getBoundingClientRect();
        if (b.width > 0 && b.height > 0) rects.push(b);
      }

      // The right-aligned action cluster: walk left from the rightmost
      // element while the gaps stay contiguous.
      rects.sort((a, b) => b.right - a.right);
      let clusterLeft = vw - 12;
      let clusterTop = headerBox.top + 16;
      let clusterBottom = headerBox.top + 52;
      if (rects.length) {
        clusterLeft = rects[0].left;
        clusterTop = rects[0].top;
        clusterBottom = rects[0].bottom;
        for (let i = 1; i < rects.length; i++) {
          if (clusterLeft - rects[i].right < 28) {
            clusterLeft = Math.min(clusterLeft, rects[i].left);
            clusterTop = Math.min(clusterTop, rects[i].top);
            clusterBottom = Math.max(clusterBottom, rects[i].bottom);
          } else {
            break;
          }
        }
      }

      // The bar is positioned inside the HOST (graph viewport). The graph is
      // full-width and the chat/help panels float over its right edge, so clamp
      // the corridor's right edge to the host MINUS any open panel — otherwise
      // the bar lands under the panel (the chips covering the chat header).
      const inset = rightInsetRef.current;
      const rightEdge = Math.min(clusterLeft, hostBox.right - inset - 12);

      // Nearest header content LEFT of the corridor (typically the
      // node/edge counts badge) — the element the user watches the bar
      // approach before it compacts.
      let neighborRight = 0;
      for (const b of rects) {
        if (b.right <= rightEdge - 4) {
          neighborRight = Math.max(neighborRight, b.right);
        }
      }
      const corridor = rightEdge - neighborRight - 24;

      let mode: BarMode;
      if (corridor >= LABELED_ROW_W) mode = 'row';
      else if (vw >= 800) mode = 'grid';
      else if (vw >= 560) mode = 'column';
      else mode = 'under';
      // The 138px column can't share a SHORT strip with the bottom legend.
      if (mode === 'column' && hostBox.height < 320) mode = 'under';

      let top: number;
      let right: number;
      if (mode === 'row') {
        // In the header row: end just left of the action cluster (or the
        // host edge, whichever is nearer), vertically centered on it.
        top = Math.round(
          clusterTop - hostBox.top + (clusterBottom - clusterTop - 30) / 2,
        );
        right = Math.round(hostBox.right - rightEdge + 12);
      } else if (mode === 'under') {
        top = Math.round(headerBox.height) + 8;
        right = inset + 12;
      } else {
        // Compact shapes hang at the corner just below the action cluster,
        // kept clear of any open right panel so they don't cover it.
        top = Math.round(clusterBottom - hostBox.top) + 6;
        right = inset + 12;
      }
      // Referential bail-out: measure runs per render/mutation — identical
      // values must NOT produce a new state object (render loop otherwise).
      setAnchor((prev) =>
        prev.mode === mode && prev.top === top && prev.right === right
          ? prev
          : { mode, top, right },
      );
    };

    // Coalesce bursts of observer callbacks into one measure per frame.
    let raf = 0;
    const scheduleMeasure = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };

    measureRef.current = scheduleMeasure;
    measure();
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(toolbar);
    ro.observe(host);
    // Header CONTENT changes (the counts badge appearing after an index, the
    // add-repo button toggling, …) shift the corridor without resizing the
    // toolbar box — a ResizeObserver alone left the bar anchored to a stale
    // layout. Watch the subtree too.
    const mo = new MutationObserver(scheduleMeasure);
    mo.observe(toolbar, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    window.addEventListener('resize', scheduleMeasure);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      elementRo.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, []);

  // Header content (e.g. the counts badge appearing after an index) can
  // change without resizing the toolbar box — re-measure on every render;
  // the component renders rarely (preset switches, parent updates).
  useEffect(() => {
    measureRef.current();
  });

  return (
    <div
      ref={barRef}
      className={`view-preset-bar view-preset-bar--${anchor.mode}`}
      style={{ top: anchor.top, right: anchor.right }}
      role="group"
      aria-label="Graph views"
    >
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`view-preset-chip${activePresetId === p.id ? ' active' : ''}`}
          title={p.description}
          onClick={() => onSelectPreset(p.id)}
        >
          <PresetIcon name={p.icon} size={15} />
          <span className="view-preset-chip-label">{p.label}</span>
        </button>
      ))}
    </div>
  );
}
