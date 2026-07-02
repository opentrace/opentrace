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
 * ShaderMaterial for the node point cloud.
 *
 * All nodes render as a single THREE.Points → one draw call regardless of
 * count. Per-vertex attributes carry position, color, base size, and a packed
 * "state" float; the GPU does size attenuation and the highlight dim/enlarge,
 * so there is NO per-frame JS loop over nodes (the Pixi bottleneck at scale).
 *
 * Sizing matches the Pixi renderer's model:
 *   on-screen radius (px) = baseSize * zoom^(1 - sizeExponent)
 * where `zoom` is the orthographic camera's px-per-world-unit. In perspective
 * (3D) mode the camera distance handles attenuation instead (uPerspective=1).
 */

import {
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  type Texture,
} from 'three';

/** Packed per-node visual state, written into the `aState` attribute. */
export const NODE_STATE_VISIBLE = 1; // bit 0 — node is visible at all
export const NODE_STATE_HIGHLIGHTED = 2; // bit 1 — part of the active highlight set
export const NODE_STATE_DIMMED = 4; // bit 2 — dimmed by another node's highlight

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aState;

  uniform float uZoom;        // ortho px-per-world-unit (camera.zoom)
  uniform float uPixelRatio;
  uniform float uSizeExp;     // zoomSizeExponent [0,1]
  uniform float uPerspective; // 1.0 = perspective (3D), 0.0 = ortho (2D)
  uniform float uHlScale;     // multiplier for highlighted nodes
  uniform float uDimScale;    // multiplier for dimmed nodes
  uniform float uDimAlpha;    // alpha for dimmed nodes

  varying vec3 vColor;
  varying float vAlpha;
  varying float vCull;

  void main() {
    int state = int(aState + 0.5);
    bool visible = (state & 1) == 1;
    bool highlighted = (state & 2) == 2;
    bool dimmed = (state & 4) == 4;

    vColor = aColor;
    float sizeMul = highlighted ? uHlScale : (dimmed ? uDimScale : 1.0);
    // Solid nodes (only dimmed nodes are translucent). 0.9 used to make every
    // node 10% see-through, which — combined with depthTest off — let nodes
    // behind show through nodes in front.
    vAlpha = dimmed ? uDimAlpha : 1.0;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    float base = aSize * sizeMul;
    // Diameter in device pixels.
    float screenPx;
    if (uPerspective > 0.5) {
      // Perspective (3D). A mild always-on depth cue keeps near nodes a touch
      // bigger so the scene still reads as 3D. The slider (uSizeExp) then scales
      // node size across a wide geometric range — 0 → large, 1 → small — so it
      // spans a visible tiny↔huge even in views like Onion where every node
      // sits at nearly the same depth (there, uZoom/depth ≈ 1.9, so the old
      // mix(persp,1) only gave a weak ~2:1 range). Anchored so the ~0.2 preset
      // default keeps the previous look.
      float persp = uZoom / max(-mv.z, 0.001);
      float depthCue = mix(1.0, persp, 0.5);
      float sizeGain = pow(12.0, 0.3 - uSizeExp);
      screenPx = base * 2.0 * uPixelRatio * depthCue * sizeGain;
    } else {
      screenPx = base * 2.0 * pow(uZoom, 1.0 - uSizeExp) * uPixelRatio;
    }
    // base <= ~0 means the node is mid build-animation reveal (size driven to
    // 0 before its "birth"); cull it. gl_PointSize 0.0 is NOT reliable — many
    // GL/ANGLE backends still rasterize a 1px fragment for a zero-size point —
    // so we also flag vCull and discard in the fragment shader.
    bool cull = !(visible && base > 0.01);
    vCull = cull ? 1.0 : 0.0;
    gl_PointSize = cull ? 0.0 : clamp(screenPx, 1.0, 128.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uUseTexture;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vCull;

  void main() {
    if (vCull > 0.5) discard; // culled point (e.g. size 0 mid build-anim)
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = dot(c, c); // squared distance from center, [0, 0.5] inside disc
    if (d > 0.25) discard;
    // Anti-aliased edge over the outer ~4% of the radius.
    float alpha = smoothstep(0.25, 0.2304, d) * vAlpha;
    if (uUseTexture > 0.5) {
      vec4 tex = texture2D(uTexture, gl_PointCoord);
      gl_FragColor = vec4(vColor * tex.rgb, alpha * tex.a);
    } else {
      gl_FragColor = vec4(vColor, alpha);
    }
  }
`;

export interface NodeMaterialUniforms {
  uZoom: { value: number };
  uPixelRatio: { value: number };
  uSizeExp: { value: number };
  uPerspective: { value: number };
  uHlScale: { value: number };
  uDimScale: { value: number };
  uDimAlpha: { value: number };
  uTexture: { value: Texture | null };
  uUseTexture: { value: number };
}

export function createNodeMaterial(
  pixelRatio: number,
  opts: { hlScale: number; dimScale: number; dimAlpha: number },
): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uZoom: { value: 1 },
      uPixelRatio: { value: pixelRatio },
      uSizeExp: { value: 0.8 },
      uPerspective: { value: 0 },
      uHlScale: { value: opts.hlScale },
      uDimScale: { value: opts.dimScale },
      uDimAlpha: { value: opts.dimAlpha },
      uTexture: { value: null },
      uUseTexture: { value: 0 },
    } satisfies NodeMaterialUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    // Kept transparent so the anti-aliased disc rim still blends, but depth
    // test + write are on so a nearer node properly occludes a farther one in
    // 3D (the "see-through" report). Node bodies are opaque (alpha 1.0), so the
    // only blended pixels are the ~1px rim — the depth halo there is negligible.
    transparent: true,
    depthTest: true,
    depthWrite: true,
    blending: NormalBlending,
  });
}

// ─── GPU picking material ─────────────────────────────────────────────────
//
// Renders each node as its index encoded in RGB to an offscreen target. One
// pixel read under the cursor gives the hit node in O(1) — no per-mousemove
// raycast over 100k points. Sizing mirrors the display material so the
// clickable disc matches what the user sees (including highlight enlarge).

const PICK_VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute float aState;
  attribute vec3 aPickColor;

  uniform float uZoom;
  uniform float uPixelRatio;
  uniform float uSizeExp;
  uniform float uPerspective;
  uniform float uHlScale;
  uniform float uDimScale;

  varying vec3 vPick;
  varying float vCull;

  void main() {
    int state = int(aState + 0.5);
    bool visible = (state & 1) == 1;
    bool highlighted = (state & 2) == 2;
    bool dimmed = (state & 4) == 4;
    vPick = aPickColor;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    float sizeMul = highlighted ? uHlScale : (dimmed ? uDimScale : 1.0);
    float base = aSize * sizeMul;
    float screenPx;
    if (uPerspective > 0.5) {
      // Match the display shader's perspective sizing (see VERTEX_SHADER) so the
      // pick target stays aligned with what's drawn.
      float persp = uZoom / max(-mv.z, 0.001);
      float depthCue = mix(1.0, persp, 0.5);
      float sizeGain = pow(12.0, 0.3 - uSizeExp);
      screenPx = base * 2.0 * uPixelRatio * depthCue * sizeGain;
    } else {
      screenPx = base * 2.0 * pow(uZoom, 1.0 - uSizeExp) * uPixelRatio;
    }
    // Mirror the display shader: a node mid-reveal (base ~0) isn't pickable,
    // and discard in the fragment so a zero-size point can't leave a pick pixel.
    bool cull = !(visible && base > 0.01);
    vCull = cull ? 1.0 : 0.0;
    gl_PointSize = cull ? 0.0 : clamp(screenPx, 1.0, 128.0);
  }
`;

const PICK_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vPick;
  varying float vCull;
  void main() {
    if (vCull > 0.5) discard;
    vec2 c = gl_PointCoord - vec2(0.5);
    if (dot(c, c) > 0.25) discard;
    gl_FragColor = vec4(vPick, 1.0);
  }
`;

export function createNodePickingMaterial(
  pixelRatio: number,
  opts: { hlScale: number; dimScale: number },
): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uZoom: { value: 1 },
      uPixelRatio: { value: pixelRatio },
      uSizeExp: { value: 0.8 },
      uPerspective: { value: 0 },
      uHlScale: { value: opts.hlScale },
      uDimScale: { value: opts.dimScale },
    },
    vertexShader: PICK_VERTEX_SHADER,
    fragmentShader: PICK_FRAGMENT_SHADER,
    // Depth on so the nearest node under the cursor wins the pick in 3D, instead
    // of whichever happened to be drawn last (matches what's now visible).
    transparent: false,
    depthTest: true,
    depthWrite: true,
    blending: NormalBlending,
  });
}

/** Exported for the (future) bloom/glow pass. */
export { AdditiveBlending };
