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
 * The OpenTrace graph viewer's **initial / reset preset** — the values the
 * app seeds its persisted panel state with and restores on "Reset graph".
 * This is the single source of truth consumed by `useGraphViewer`.
 *
 * IMPORTANT — this is the *viewer preset*, NOT the bare fallback props of
 * `PixiGraphCanvas` / `PhysicsPanel`. Most fields match those components'
 * defaults, but three intentionally diverge because the OpenTrace viewer
 * ships a more opinionated initial view than a bare-mounted component:
 *
 *   | field              | this preset | component fallback |
 *   | ------------------ | ----------- | ------------------ |
 *   | `layoutMode`       | `'compact'` | `'spread'`         |
 *   | `mode3d`           | `true`      | `false`            |
 *   | `pixiZoomExponent` | `0.25`      | `0.8`              |
 *
 * Prop-driven consumers of `PixiGraphCanvas` + `PhysicsPanel` (without the
 * store/providers) can import this from the store-free, WebGL-free `./utils`
 * entry point to initialize a controlled panel with the *same preset the
 * OpenTrace viewer uses* and track it on version bumps — just know that doing
 * so reproduces the viewer's opinionated defaults, not the components' bare
 * fallbacks. The contract (which fields match the component fallbacks and
 * which deliberately differ) is pinned by
 * `__tests__/graphSettingDefaults.test.ts`.
 *
 * Field names here are the viewer's persisted keys; consumers map them onto
 * the components' prop names, e.g. `pixiLinkDist` → `linkDistance`,
 * `compactRadial` → `radialStrength`, `pixiZoomExponent` → `zoomSizeExponent`.
 *
 * Plain object literal with NO runtime dependencies (no store, providers,
 * pixi, or `useGraphViewer`), so importing it never pulls in WebGL.
 */
export const GRAPH_SETTING_DEFAULTS = {
  zoomOnSelect: false,
  // Charge magnitude — matches the renderer's FORCE_CHARGE_STRENGTH (-200) so
  // the slider value is the actual repulsion the worker initializes with. (Was
  // 120, which silently disagreed with the -200 the layout really used.)
  repulsion: 200,
  labelsVisible: true,
  edgesVisible: true,
  communityLabelsVisible: true,
  pixiLinkDist: 200,
  pixiCenter: 0.3,
  pixiZoomExponent: 0.25,
  layoutMode: 'compact' as 'spread' | 'compact' | 'tree' | 'onion',
  compactRadial: 8,
  compactCommunity: 10,
  compactCentering: 5,
  compactRadius: 32,
  mode3d: true,
  mode3dSpeed: 15,
  mode3dTilt: 35,
  labelScale: 100,
  edgeOpacity: 100,
  communitiesEnabled: true,
  // Gentle perpetual node drift after the layout settles. On by default; users
  // can disable it (and it auto-eases on very large graphs).
  ambientMotion: true,
};

/** Shape of {@link GRAPH_SETTING_DEFAULTS}. */
export type GraphSettingDefaults = typeof GRAPH_SETTING_DEFAULTS;
