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

/**
 * Graph "view presets" — named bundles of layout + physics + color settings
 * that snap the canvas into a recognizable look in one click. Each preset
 * fully specifies every controllable setting so applying it is deterministic
 * regardless of the prior state.
 *
 * The preset values map onto the same settings the PhysicsPanel sliders drive
 * (see GRAPH_SETTING_DEFAULTS in useGraphViewer). `applyPreset` in GraphViewer
 * pushes them into both React state and the renderer's imperative API.
 */

export type GraphPresetId = 'flat' | 'bundled' | 'planet' | 'onion';

/** Sentinel stored when the user hand-tweaks a control, so no preset chip
 *  shows as active. Not a real preset. */
export const CUSTOM_PRESET = 'custom';

export interface GraphPresetSettings {
  layoutMode: 'spread' | 'compact' | 'tree' | 'onion';
  mode3d: boolean;
  autoRotate: boolean;
  colorMode: 'type' | 'community';
  communitiesEnabled: boolean;
  communityLabelsVisible: boolean;
  /** Charge magnitude (slider units; renderer charge is negated). */
  repulsion: number;
  linkDistance: number;
  /** Spread-mode center pull (0–1). */
  centerStrength: number;
  /** Compact-mode forces (slider units; see updateCompactConfig). */
  compactRadial: number;
  compactCommunity: number;
  compactCentering: number;
  compactRadius: number;
  /** Edge-opacity multiplier as a percentage (100 = default). */
  edgeOpacity: number;
  // Every remaining control is specified too, so applying a preset is a full
  // reset — no setting from the previously-active preset bleeds through.
  /** Zoom-size exponent (0–1). */
  zoomSizeExponent: number;
  /** Label-size multiplier as a percentage (100 = default). */
  labelScale: number;
  /** 3D auto-rotation speed (percentage). */
  mode3dSpeed: number;
  /** 3D camera tilt (percentage). */
  mode3dTilt: number;
  labelsVisible: boolean;
  edgesVisible: boolean;
  /** Enable the nebula cloud layout (worker-internal mode). */
  nebula: boolean;
}

export interface GraphPreset {
  id: GraphPresetId;
  label: string;
  /** Icon key — resolved to a flat SVG in PhysicsPanel's PRESET_ICONS map. */
  icon: string;
  /** One-line tooltip. */
  description: string;
  settings: GraphPresetSettings;
}

/** Default applied on a user's first-ever graph load (no stored preset yet). */
export const DEFAULT_PRESET_ID: GraphPresetId = 'planet';

export const GRAPH_PRESETS: GraphPreset[] = [
  {
    id: 'bundled',
    label: 'Bundled',
    icon: 'clusters',
    description:
      'Tight, jewel-colored community clusters in 3D with cluster labels — the modular structure balled up into distinct clumps.',
    settings: {
      layoutMode: 'compact',
      mode3d: true,
      autoRotate: false,
      colorMode: 'community',
      communitiesEnabled: true,
      communityLabelsVisible: true,
      repulsion: 150,
      linkDistance: 110,
      centerStrength: 0.3,
      compactRadial: 12,
      compactCommunity: 48,
      compactCentering: 10,
      compactRadius: 22,
      edgeOpacity: 45,
      // Matches Planet's zoom scaling (displays as 20% on the slider) so nodes
      // attenuate identically across every preset.
      zoomSizeExponent: 0.8,
      labelScale: 100,
      mode3dSpeed: 12,
      mode3dTilt: 35,
      labelsVisible: true,
      edgesVisible: true,
      nebula: false,
    },
  },
  {
    id: 'onion',
    label: 'Onion',
    icon: 'onion',
    description:
      'A flat, top-down map — every node type forms its own concentric ring, nested core-to-rim (repo at the center, functions & dependencies on the outer rings). Colored by node type.',
    settings: {
      // 'onion' layout in 2D renders as a cross-section: concentric annular
      // bands, one per node type (see computeOnion in forceLayout3dWorker).
      layoutMode: 'onion',
      mode3d: false,
      autoRotate: false,
      colorMode: 'type',
      communitiesEnabled: false,
      communityLabelsVisible: false,
      repulsion: 250,
      linkDistance: 120,
      centerStrength: 0.3,
      compactRadial: 8,
      compactCommunity: 10,
      compactCentering: 5,
      compactRadius: 16,
      // Cross-ring edges crisscross the map and clutter it — hide them (and
      // labels) so the clean concentric rings read on their own.
      edgeOpacity: 0,
      // Matches Planet's zoom scaling (displays as 20% on the slider).
      zoomSizeExponent: 0.8,
      labelScale: 90,
      mode3dSpeed: 15,
      mode3dTilt: 35,
      labelsVisible: false,
      edgesVisible: true,
      nebula: false,
    },
  },
  {
    id: 'planet',
    label: 'Planet',
    icon: 'sphere',
    description:
      'A free-floating 3D sphere of the whole graph — spacious and slowly explorable, colored by node type.',
    settings: {
      layoutMode: 'compact',
      mode3d: true,
      autoRotate: false,
      colorMode: 'type',
      communitiesEnabled: false,
      communityLabelsVisible: false,
      repulsion: 430,
      linkDistance: 480,
      centerStrength: 0.3,
      compactRadial: 1,
      compactCommunity: 0,
      compactCentering: 0,
      compactRadius: 39,
      edgeOpacity: 15,
      // Displays as 20% on the "Zoom scaling" slider (0 = big, 1 = small).
      zoomSizeExponent: 0.8,
      labelScale: 72,
      mode3dSpeed: 15,
      mode3dTilt: 35,
      labelsVisible: true,
      edgesVisible: true,
      nebula: false,
    },
  },
  {
    id: 'flat',
    label: 'Flat',
    icon: 'network',
    description:
      'A 2D map of organic clusters — related code pulls together so edges stay short. Colored by community.',
    settings: {
      layoutMode: 'spread',
      mode3d: false,
      autoRotate: false,
      colorMode: 'community',
      communitiesEnabled: true,
      communityLabelsVisible: false,
      repulsion: 200,
      linkDistance: 200,
      centerStrength: 0.3,
      compactRadial: 8,
      compactCommunity: 10,
      compactCentering: 5,
      compactRadius: 16,
      // Kept low: thousands of intra-cluster edges read as noise at full
      // strength — the clusters themselves carry the structure.
      edgeOpacity: 35,
      // Matches Planet's zoom scaling (displays as 20% on the slider) so nodes
      // attenuate identically across every preset.
      zoomSizeExponent: 0.8,
      labelScale: 100,
      mode3dSpeed: 15,
      mode3dTilt: 35,
      labelsVisible: true,
      edgesVisible: true,
      nebula: false,
    },
  },
];

export function getPreset(id: string | null): GraphPreset | undefined {
  return GRAPH_PRESETS.find((p) => p.id === id);
}
