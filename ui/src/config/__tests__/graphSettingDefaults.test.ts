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

import { describe, it, expect } from 'vitest';
import { GRAPH_SETTING_DEFAULTS } from '../graphSettingDefaults';

/**
 * Contract test for the graph-viewer preset.
 *
 * `GRAPH_SETTING_DEFAULTS` is the OpenTrace viewer's initial/reset preset, and
 * is exposed publicly via `@opentrace/opentrace/utils` for prop-driven
 * consumers of `PixiGraphCanvas` + `PhysicsPanel`. This test pins the
 * relationship between the preset and those components' bare fallback props so
 * neither side can drift silently:
 *
 *  - fields that are meant to match the component fallbacks are asserted equal;
 *  - the three fields that *intentionally* diverge are asserted to still
 *    diverge, so changing either side trips this test and forces a conscious
 *    decision rather than an accidental behavior change.
 *
 * The component-fallback values below mirror the prop defaults declared in
 * `src/components/panels/PhysicsPanel.tsx` (and `PixiGraphCanvas.tsx`). Keep
 * them in sync if those defaults change.
 */

// Bare fallback prop defaults of PhysicsPanel / PixiGraphCanvas, keyed by the
// component prop name. Source: PhysicsPanel.tsx default-prop destructuring.
const COMPONENT_FALLBACKS = {
  linkDistance: 200,
  centerStrength: 0.3,
  edgesEnabled: true,
  layoutMode: 'spread' as const,
  communityLabelsVisible: true,
  communitiesEnabled: true,
  radialStrength: 8,
  communityPull: 10,
  centeringStrength: 5,
  circleRadius: 32,
  zoomSizeExponent: 0.8,
  labelScale: 100,
  mode3d: false,
  mode3dSpeed: 30,
  mode3dTilt: 35,
};

describe('GRAPH_SETTING_DEFAULTS contract', () => {
  it('matches the component fallbacks for the shared (non-opinionated) fields', () => {
    // viewer-preset key -> component fallback key, for the fields that should
    // always agree between the preset and a bare-mounted component.
    expect(GRAPH_SETTING_DEFAULTS.pixiLinkDist).toBe(
      COMPONENT_FALLBACKS.linkDistance,
    );
    expect(GRAPH_SETTING_DEFAULTS.pixiCenter).toBe(
      COMPONENT_FALLBACKS.centerStrength,
    );
    expect(GRAPH_SETTING_DEFAULTS.edgesVisible).toBe(
      COMPONENT_FALLBACKS.edgesEnabled,
    );
    expect(GRAPH_SETTING_DEFAULTS.communityLabelsVisible).toBe(
      COMPONENT_FALLBACKS.communityLabelsVisible,
    );
    expect(GRAPH_SETTING_DEFAULTS.communitiesEnabled).toBe(
      COMPONENT_FALLBACKS.communitiesEnabled,
    );
    expect(GRAPH_SETTING_DEFAULTS.compactRadial).toBe(
      COMPONENT_FALLBACKS.radialStrength,
    );
    expect(GRAPH_SETTING_DEFAULTS.compactCommunity).toBe(
      COMPONENT_FALLBACKS.communityPull,
    );
    expect(GRAPH_SETTING_DEFAULTS.compactCentering).toBe(
      COMPONENT_FALLBACKS.centeringStrength,
    );
    expect(GRAPH_SETTING_DEFAULTS.compactRadius).toBe(
      COMPONENT_FALLBACKS.circleRadius,
    );
    expect(GRAPH_SETTING_DEFAULTS.labelScale).toBe(
      COMPONENT_FALLBACKS.labelScale,
    );
    expect(GRAPH_SETTING_DEFAULTS.mode3dSpeed).toBe(
      COMPONENT_FALLBACKS.mode3dSpeed,
    );
    expect(GRAPH_SETTING_DEFAULTS.mode3dTilt).toBe(
      COMPONENT_FALLBACKS.mode3dTilt,
    );
  });

  it('intentionally diverges from the component fallbacks for the opinionated fields', () => {
    // The viewer ships compact + 3D + a tighter zoom exponent. These MUST
    // differ from the bare component fallbacks; if a change makes them agree,
    // re-evaluate whether the divergence is still intended and update the
    // docs/table in graphSettingDefaults.ts.
    expect(GRAPH_SETTING_DEFAULTS.layoutMode).toBe('compact');
    expect(GRAPH_SETTING_DEFAULTS.layoutMode).not.toBe(
      COMPONENT_FALLBACKS.layoutMode,
    );

    expect(GRAPH_SETTING_DEFAULTS.mode3d).toBe(true);
    expect(GRAPH_SETTING_DEFAULTS.mode3d).not.toBe(COMPONENT_FALLBACKS.mode3d);

    expect(GRAPH_SETTING_DEFAULTS.pixiZoomExponent).toBe(0.25);
    expect(GRAPH_SETTING_DEFAULTS.pixiZoomExponent).not.toBe(
      COMPONENT_FALLBACKS.zoomSizeExponent,
    );
  });
});
