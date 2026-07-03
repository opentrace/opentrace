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

import type { ReactNode } from 'react';

/** Flat line-icons for the view presets, keyed by GraphPreset.icon. Drawn in
 *  the app's feather-style (24-box, currentColor stroke) so they inherit the
 *  chip's text color + active state. Shared by the floating ViewPresetBar and
 *  the PhysicsPanel preset grid. */
const PRESET_ICON_PATHS: Record<string, ReactNode> = {
  // Spacious sphere (Planet): a globe.
  sphere: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </>
  ),
  // Layered ball (Onion): concentric shells.
  onion: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5.5" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  // Tight community clusters (Bundled): overlapping blobs.
  clusters: (
    <>
      <circle cx="9" cy="10" r="4" />
      <circle cx="16" cy="8" r="3" />
      <circle cx="13" cy="16" r="3.5" />
    </>
  ),
  // 2D force network (Flat): three connected nodes.
  network: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="7" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M6.8 6.7 17.2 6.9M6.3 7.7 11 16M17.6 8 13 16.2" />
    </>
  ),
};

export function PresetIcon({
  name,
  size = 20,
}: {
  name: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PRESET_ICON_PATHS[name] ?? PRESET_ICON_PATHS.sphere}
    </svg>
  );
}
