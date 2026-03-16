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

import { useEffect, useState } from 'react';

// ─── Path data from original SVG ───
const ORANGE_PATH =
  'm165.36 92.46c-0.0205-2.5891 0.89009-4.6299 2.7999-6.203 1.8093-1.4903 3.2036-3.1696 3.2528-5.6681 0.0701-3.5587 0.0803-7.1103-2.2102-10.129-1.1246-1.482-2.8031-1.7588-4.572-1.4435-2.7673 0.49325-5.2411 4.2704-4.5147 6.9532 0.57927 2.1392 0.74199 4.2383-0.15167 6.3283-1.6273 3.8056-6.1755 5.8805-10.259 4.6808-4.1256-1.2121-6.7036-5.3192-5.9433-9.469 0.79479-4.3381 4.7779-7.4114 9.2047-7.1022 4.5527 0.31812 7.5544-1.6935 8.3477-5.5943 0.75433-3.7094-1.6033-7.424-5.5632-8.7845-3.4358-1.1808-6.3908-0.5347-8.9552 2.0848-3.3287 3.4-7.3752 4.5819-11.954 3.0867-4.6186-1.5083-7.1767-4.8868-7.9698-9.5749-0.90874-5.3711 2.8692-10.951 8.4724-12.592 5.2962-1.5515 11.256 1.049 13.523 5.9085 6.5392 14.021 15.626 5.3186 15.989 4.9619 2.7609-2.707 3.1075-8.2778 0.66041-11.27-3.405-2.6314-7.0119-3.694-7.1224-8.8084 0.076-3.0957 1.5439-5.5305 4.5785-6.8157 3.3551-1.4209 7.1094-0.34802 9.3605 2.6835 2.1483 2.893 2.2248 6.8265-0.42777 9.2948-3.0043 2.7957-2.2106 7.413-0.24574 10.071 1.5841 2.1435 4.4235 2.8316 7.0899 1.5114 3.8429-1.9028 7.9785-5.7747 6.7648-12.143-1.5913-8.3494 5.6539-14.951 13.358-14.271 7.6782 0.67776 12.7 7.3934 11.327 14.85-1.2944 7.0322-8.5755 11.375-15.866 9.3692-3.9408-1.0845-7.1549 0.13074-9.869 2.8495-2.6362 2.6405-3.819 5.8389-2.8127 9.5408 1.0926 4.0186 5.618 7.521 9.7631 7.7182 1.406 0.06686 2.5814-0.5613 3.7978-1.1235 5.0987-2.3569 10.83 0.63746 11.759 6.1219 0.72383 4.2774-2.067 8.2397-6.5288 9.2695-3.9397 0.90908-8.5523-1.6422-9.6521-6.4359-0.99636-4.3445-4.1265-6.7767-8.5445-6.6373-3.8988 0.12298-7.087 3.0569-7.6685 7.3002-0.38804 2.8319-0.18478 5.6614 0.73881 8.4216 0.60014 1.7936 1.8461 2.907 3.4052 3.8954 3.897 2.4705 5.3044 7.2821 3.3996 11.213-1.7584 3.6282-5.9396 5.6282-9.9364 4.7527-4.106-0.89937-6.7247-4.2243-6.8244-8.802z';

const BLOB_PATH =
  'm839.64 874.8c13.787 32.698-1.5784 63.373-32.746 67.738-20.75 2.9055-39.925-7.9386-47.756-27.008-7.9941-19.465-1.5384-43.38 14.631-54.203 19.237-12.876 41.648-11.689 57.737 3.2721 2.8533 2.6533 5.0356 6.0117 8.1329 10.201z';

// ─── Node data: [sizeClass, delayClass, cx, cy, r] ───
const NODES: [string, string, number, number, number][] = [
  ['sz-xl', 'd0', 191.4, 115.7, 19.6],
  ['sz-xl2', 'd2', 54.5, 30.9, 18.3],
  ['sz-lg', 'd4', 20.6, 173.7, 13.1],
  ['sz-lg', 'd6', 245.5, 120.8, 13.1],
  ['sz-md', 'd1', 96.5, 89.6, 10.4],
  ['sz-md', 'd3', 80.6, 141.9, 10.4],
  ['sz-md', 'd5', 166.7, 172.1, 10.4],
  ['sz-md', 'd7', 148.9, 76.5, 10.4],
  ['sz-md', 'd2', 163.5, 12.0, 10.4],
  ['sz-smd', 'd4', 118.0, 178.5, 9.1],
  ['sz-sm', 'd0', 71.4, 56.0, 5.0],
  ['sz-sm', 'd1', 82.5, 70.6, 5.0],
  ['sz-sm', 'd3', 158.2, 34.3, 5.0],
  ['sz-sm', 'd5', 155.8, 52.6, 5.0],
  ['sz-sm', 'd7', 180.2, 196.3, 5.0],
  ['sz-sm', 'd1', 42.0, 159.8, 5.0],
  ['sz-sm', 'd3', 59.2, 152.8, 5.0],
  ['sz-sm', 'd2', 112.4, 198.9, 5.0],
  ['sz-sm', 'd4', 104.9, 213.4, 5.0],
  ['sz-sm', 'd6', 98.0, 227.2, 5.0],
  ['sz-sm', 'd5', 220.3, 116.9, 5.0],
];

// ─── Theme tokens ───
interface ThemeTokens {
  nodeColor: string;
  nodeStroke: string;
  glowColor: string;
}

const LIGHT_THEME: ThemeTokens = {
  nodeColor: '#000000',
  nodeStroke: '#000000',
  glowColor: 'rgba(255,102,0,0.08)',
};

const DARK_THEME: ThemeTokens = {
  nodeColor: '#d8d8e0',
  nodeStroke: '#d8d8e0',
  glowColor: 'rgba(255,102,0,0.12)',
};

// ─── Shared animation CSS (injected once into <head>) ───
const STYLES_ID = 'ot-logo-styles';

const LOGO_CSS = `
  /*
   * OpenTrace logo animation cycle — 6s total, ease-in-out, infinite
   *
   * ─── Phase 1: Entry / Drawing (0% → 28% = 0s → 1.68s) ───────────────────────
   *   0%   Orange stroke begins drawing (dashoffset 600 → 0)
   *   3%   Node strokes become visible
   *   6%   Node strokes start drawing
   *  18%   All strokes fully drawn; fills begin fading in
   *  22%   Orange stroke fully drawn
   *  28%   Fills reach full opacity; strokes cross-fade out    → fully colored
   *
   * ─── Phase 2: Static / Fully colored (28% → 55% = 1.68s → 3.30s = 1.62s) ───
   *  28%–55%  All fills solid, all strokes invisible.
   *           Only the ambient glow breathes (ot-breathe, separate 6s cycle).
   *
   * ─── Phase 3: Exit / Fading (55% → 100% = 3.30s → 6.00s = 2.70s) ──────────
   *  55%  Fills begin fading out
   *  60%  Node fills at 70% opacity
   *  62%  Node strokes reappear (draw-retract begins)
   *  65%  Orange stroke reappears; node fills at 40%
   *  70%  All fills gone
   *  75%  Node strokes fully retracted (dashoffset back to initial)
   *  80%  Node strokes at 50% opacity
   *  85%  Node strokes gone
   * 100%  Orange stroke fully retracted → loop
   */

  @keyframes ot-draw-stroke {
    /* Entry: draw in */
    0%   { stroke-dashoffset: 600; opacity: 1; }
    22%  { stroke-dashoffset: 0;   opacity: 1; }
    30%  { stroke-dashoffset: 0;   opacity: 0; }
    /* Static: invisible */
    60%  { stroke-dashoffset: 0;   opacity: 0; }
    /* Exit: reappear and retract */
    65%  { stroke-dashoffset: 0;   opacity: 1; }
    100% { stroke-dashoffset: 600; opacity: 1; }
  }
  @keyframes ot-fill-in {
    /* Entry: fade in */
    0%, 18% { opacity: 0; }
    28%     { opacity: 1; }
    /* Static: hold */
    55%     { opacity: 1; }
    /* Exit: fade out */
    70%, 100% { opacity: 0; }
  }
  @keyframes ot-nd-draw {
    /* Entry: draw in */
    0%, 3% { stroke-dashoffset: inherit; opacity: 0; }
    6%     { stroke-dashoffset: inherit; opacity: 1; }
    22%    { stroke-dashoffset: 0;       opacity: 1; }
    28%    { stroke-dashoffset: 0;       opacity: 0; }
    /* Static: invisible */
    58%    { stroke-dashoffset: 0;       opacity: 0; }
    /* Exit: reappear and retract */
    62%    { stroke-dashoffset: 0;       opacity: 1; }
    75%    { stroke-dashoffset: inherit; opacity: 1; }
    80%    { stroke-dashoffset: inherit; opacity: 0.5; }
    85%, 100% { stroke-dashoffset: inherit; opacity: 0; }
  }
  @keyframes ot-nd-solid {
    /* Entry: fade in */
    0%, 18% { opacity: 0; }
    28%     { opacity: 1; }
    /* Static: hold */
    55%     { opacity: 1; }
    /* Exit: stepped fade out */
    60%     { opacity: 0.7; }
    65%     { opacity: 0.4; }
    70%, 100% { opacity: 0; }
  }
  @keyframes ot-breathe {
    0%, 100% { opacity: 0.25; transform: translate(-50%, -50%) scale(0.92); }
    35%, 70% { opacity: 0.9; transform: translate(-50%, -50%) scale(1); }
  }

  .ot-sz-xl  .ot-nd-stroke { stroke-dasharray: 123; stroke-dashoffset: 123; }
  .ot-sz-xl2 .ot-nd-stroke { stroke-dasharray: 115; stroke-dashoffset: 115; }
  .ot-sz-lg  .ot-nd-stroke { stroke-dasharray: 82;  stroke-dashoffset: 82; }
  .ot-sz-md  .ot-nd-stroke { stroke-dasharray: 65;  stroke-dashoffset: 65; }
  .ot-sz-smd .ot-nd-stroke { stroke-dasharray: 57;  stroke-dashoffset: 57; }
  .ot-sz-sm  .ot-nd-stroke { stroke-dasharray: 31;  stroke-dashoffset: 31; }
  .ot-sz-blob .ot-nd-stroke { stroke-dasharray: 300; stroke-dashoffset: 300; }

  .ot-d0 .ot-nd-stroke, .ot-d0 .ot-nd-fill { animation-delay: 0.00s; }
  .ot-d1 .ot-nd-stroke, .ot-d1 .ot-nd-fill { animation-delay: 0.10s; }
  .ot-d2 .ot-nd-stroke, .ot-d2 .ot-nd-fill { animation-delay: 0.20s; }
  .ot-d3 .ot-nd-stroke, .ot-d3 .ot-nd-fill { animation-delay: 0.30s; }
  .ot-d4 .ot-nd-stroke, .ot-d4 .ot-nd-fill { animation-delay: 0.40s; }
  .ot-d5 .ot-nd-stroke, .ot-d5 .ot-nd-fill { animation-delay: 0.50s; }
  .ot-d6 .ot-nd-stroke, .ot-d6 .ot-nd-fill { animation-delay: 0.60s; }
  .ot-d7 .ot-nd-stroke, .ot-d7 .ot-nd-fill { animation-delay: 0.70s; }
`;

export interface OpenTraceLogoProps {
  /** Width and height of the logo in pixels. Default: 80 */
  size?: number;
  /** Whether to run the draw/fill animations. Default: true */
  animated?: boolean;
  className?: string;
}

export function OpenTraceLogo({
  size = 80,
  animated = true,
  className,
}: OpenTraceLogoProps) {
  const [isDark, setIsDark] = useState(
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('dark'),
  );

  useEffect(() => {
    if (!document.getElementById(STYLES_ID)) {
      const style = document.createElement('style');
      style.id = STYLES_ID;
      style.textContent = LOGO_CSS;
      document.head.appendChild(style);
    }
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains('dark'));
    });
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const t = isDark ? DARK_THEME : LIGHT_THEME;
  const glowSize = Math.round(size * 1.625);

  const nodeStrokeStyle = animated
    ? { animation: 'ot-nd-draw 6s ease-in-out infinite' }
    : { opacity: 1 as const };

  const nodeFillStyle = animated
    ? { animation: 'ot-nd-solid 6s ease-in-out infinite' }
    : { opacity: 1 as const };

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'visible',
        width: size,
        height: size,
      }}
    >
      {/* Ambient glow */}
      <div
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          top: '50%',
          left: '50%',
          borderRadius: '9999px',
          width: glowSize,
          height: glowSize,
          background: `radial-gradient(circle, ${t.glowColor} 0%, transparent 65%)`,
          animation: animated
            ? 'ot-breathe 6s ease-in-out infinite'
            : undefined,
          transform: animated ? undefined : 'translate(-50%, -50%)',
          opacity: animated ? undefined : 0.6,
        }}
      />

      {/* Unified SVG using the nodes coordinate system (0 0 260 256) as the base */}
      <svg
        viewBox="0 0 260 256"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          overflow: 'visible',
        }}
        aria-hidden="true"
      >
        {/* Orange path — nested SVG preserves its own viewBox/coordinate system */}
        <svg
          viewBox="0 0 87.156 85.692"
          x={0}
          y={0}
          width={260}
          height={256}
          overflow="visible"
        >
          <g transform="translate(-126.21 -15.875)">
            <path
              d={ORANGE_PATH}
              fill="none"
              stroke="#f60"
              strokeWidth={0.65}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={600}
              strokeDashoffset={600}
              style={
                animated
                  ? { animation: 'ot-draw-stroke 6s ease-in-out infinite' }
                  : { opacity: 0 }
              }
            />
            <path
              d={ORANGE_PATH}
              fill="#f60"
              style={
                animated
                  ? { animation: 'ot-fill-in 6s ease-in-out infinite' }
                  : { opacity: 1 }
              }
            />
          </g>
        </svg>

        {/* Nodes */}
        {NODES.map(([sz, delay, cx, cy, r], i) => (
          <g key={i} className={`ot-${sz} ot-${delay}`}>
            <circle
              className="ot-nd-stroke"
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={t.nodeStroke}
              strokeWidth={1.5}
              strokeLinecap="round"
              style={nodeStrokeStyle}
            />
            <circle
              className="ot-nd-fill"
              cx={cx}
              cy={cy}
              r={r}
              fill={t.nodeColor}
              stroke="none"
              style={nodeFillStyle}
            />
          </g>
        ))}

        {/* Blob — nested SVG at the pre-scaled position in node-space coords */}
        <svg
          viewBox="780 850 100 100"
          x={182}
          y={208}
          width={52}
          height={46}
          overflow="visible"
        >
          <g className="ot-sz-blob ot-d3">
            <path
              className="ot-nd-stroke"
              d={BLOB_PATH}
              fill="none"
              stroke={t.nodeStroke}
              strokeWidth={3}
              strokeLinecap="round"
              style={nodeStrokeStyle}
            />
            <path
              className="ot-nd-fill"
              d={BLOB_PATH}
              fill={t.nodeColor}
              stroke="none"
              style={nodeFillStyle}
            />
          </g>
        </svg>
      </svg>
    </div>
  );
}
