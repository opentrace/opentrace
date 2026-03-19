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

import { useEffect, useRef, useState } from "react";
import type { GraphLegendProps } from "./types";
import "./GraphLegend.css";

const DEFAULT_MAX_VISIBLE = 5;

type LegendEntry = {
  key: string;
  label: string;
  count: number;
  color: string;
  shape: "dot" | "line";
};

export default function GraphLegend({
  colorMode,
  legendItems,
  communityLegendItems,
  legendLinkItems,
  maxVisible = DEFAULT_MAX_VISIBLE,
}: GraphLegendProps) {
  const [showOverflow, setShowOverflow] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!showOverflow) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setShowOverflow(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showOverflow]);

  // Build node/community items (truncatable) and link items (always shown)
  const nodeItems: LegendEntry[] = [];
  if (colorMode === "community") {
    for (const { label, count, color } of communityLegendItems) {
      nodeItems.push({ key: `c:${label}`, label, count, color, shape: "dot" });
    }
  } else {
    for (const { type, count, color } of legendItems) {
      nodeItems.push({
        key: `n:${type}`,
        label: type,
        count,
        color,
        shape: "dot",
      });
    }
  }

  const linkItems: LegendEntry[] = [];
  for (const { type, count, color } of legendLinkItems) {
    linkItems.push({
      key: `l:${type}`,
      label: type,
      count,
      color,
      shape: "line",
    });
  }

  const visibleNodes = nodeItems.slice(0, maxVisible);
  const overflowNodes = nodeItems.slice(maxVisible);

  return (
    <div className="legend" ref={popoverRef}>
      {visibleNodes.map(({ key, label, count, color }) => (
        <span key={key} className="legend-item" title={label}>
          <span className="legend-dot" style={{ backgroundColor: color }} />
          <span className="legend-count">{count}</span>
          {label.length > 10 ? label.slice(0, 10) + "…" : label}
        </span>
      ))}
      {overflowNodes.length > 0 && (
        <>
          <button
            className="legend-more-btn"
            onClick={() => setShowOverflow((v) => !v)}
          >
            +{overflowNodes.length} more
          </button>
          {showOverflow && (
            <div className="legend-popover">
              {nodeItems.map(({ key, label, count, color }) => (
                <span key={key} className="legend-item">
                  <span
                    className="legend-dot"
                    style={{ backgroundColor: color }}
                  />
                  <span className="legend-count">{count}</span>
                  {label}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      {linkItems.length > 0 && (
        <>
          <span className="legend-divider" />
          {linkItems.map(({ key, label, count, color }) => (
            <span key={key} className="legend-item">
              <span
                className="legend-line"
                style={{ backgroundColor: color }}
              />
              <span className="legend-count">{count}</span>
              {label}
            </span>
          ))}
        </>
      )}
    </div>
  );
}
