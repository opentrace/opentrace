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
 * Single source of truth for the default values of every persisted panel
 * setting. Used to initialize state and to power the "Reset graph" button —
 * keep these in sync with the literal defaults that the renderer / physics
 * layout ships with.
 *
 * This is a plain object literal with NO runtime dependencies (no store,
 * providers, pixi, or `useGraphViewer`). It lives in its own module so that
 * prop-driven consumers of `PixiGraphCanvas` + `PhysicsPanel` (without the
 * store/providers) can import the defaults from the store-free, WebGL-free
 * `./utils` entry point and track them on version bumps instead of hardcoding
 * copies.
 */
export const GRAPH_SETTING_DEFAULTS = {
  zoomOnSelect: false,
  repulsion: 120,
  labelsVisible: true,
  edgesVisible: true,
  communityLabelsVisible: true,
  pixiLinkDist: 200,
  pixiCenter: 0.3,
  pixiZoomExponent: 0.25,
  layoutMode: 'compact' as 'spread' | 'compact',
  compactRadial: 8,
  compactCommunity: 10,
  compactCentering: 5,
  compactRadius: 32,
  mode3d: true,
  mode3dSpeed: 30,
  mode3dTilt: 35,
  labelScale: 100,
  communitiesEnabled: true,
};

/** Shape of {@link GRAPH_SETTING_DEFAULTS}. */
export type GraphSettingDefaults = typeof GRAPH_SETTING_DEFAULTS;
