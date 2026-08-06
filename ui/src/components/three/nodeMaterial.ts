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
 * Sizing model (2D):
 *   on-screen radius (px) = baseSize * mix(1, zoomNorm, 0.5) * 12^(0.3-exp)
 * where `zoomNorm` is the ortho camera zoom NORMALIZED by the whole-graph fit
 * (1.0 at the overview fit). Normalizing makes node size independent of the
 * layout's world extent, so compact (Onion) and sprawling (Flat) layouts match
 * — and the exponent uses the SAME geometric gain as the 3D branch (0 = large,
 * 1 = small), so the "Zoom scaling" slider looks identical in both modes. In
 * perspective (3D) mode the camera distance handles attenuation (uPerspective=1).
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
export const NODE_STATE_HOVERED = 8; // bit 3 — under the cursor (grows slightly)

/** Size multiplier for the node under the cursor. */
export const NODE_HOVER_SCALE = 1.3;

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aState;

  uniform float uZoom;        // ortho px-per-world-unit (camera.zoom)
  uniform float uPixelRatio;
  uniform float uSizeExp;     // zoomSizeExponent [0,1]
  uniform float uPerspective; // 1.0 = perspective (3D), 0.0 = ortho (2D)
  uniform float uHlScale;     // multiplier for highlighted nodes
  uniform float uHlAlpha;     // alpha for highlighted nodes
  uniform float uDimScale;    // multiplier for dimmed nodes
  uniform float uDimAlpha;    // alpha for dimmed nodes

  varying vec3 vColor;
  varying float vAlpha;
  varying float vCull;
  varying float vGlow;

  void main() {
    int state = int(aState + 0.5);
    bool visible = (state & 1) == 1;
    bool highlighted = (state & 2) == 2;
    bool dimmed = (state & 4) == 4;
    bool hovered = (state & 8) == 8;

    vColor = aColor;
    // Highlighted nodes (chat traversal / search / selection) render as a
    // bright core + soft halo in the fragment shader.
    vGlow = highlighted ? 1.0 : 0.0;
    float sizeMul = highlighted ? uHlScale : (dimmed ? uDimScale : 1.0);
    // Hover grows the node a touch so the click target is obvious. 1.3 must
    // match NODE_HOVER_SCALE.
    if (hovered) sizeMul *= 1.3;
    // Highlighted nodes render airy (uHlAlpha < 1) so the enlarge + glow read
    // as a soft beacon, not a heavy solid disc. Dimmed nodes are translucent.
    // Everything else is solid — 0.9 used to make every node 10% see-through,
    // which, combined with depthTest off, let nodes behind show through in front.
    vAlpha = highlighted ? uHlAlpha : (dimmed ? uDimAlpha : 1.0);

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
      // Ortho (2D): uZoom is the camera zoom NORMALIZED by the whole-graph fit
      // (1.0 at the overview fit), so node screen size is independent of the
      // layout's world extent — a compact layout (Onion) and a sprawling one
      // (Flat) render nodes the same size at their fit, matching 3D. Before
      // this, pow(camZoom, exp) scaled size with the raw fit zoom, so the
      // compact Onion layout (high fit zoom) rendered huge nodes at the same
      // slider value. uSizeExp sets absolute size via the SAME geometric gain
      // as the perspective branch (0 = large, 1 = small); the mild mix() adds a
      // gentle zoom-in growth mirroring 3D's depth cue.
      float zoomCue = mix(1.0, uZoom, 0.5);
      float sizeGain = pow(12.0, 0.3 - uSizeExp);
      screenPx = base * 2.0 * uPixelRatio * zoomCue * sizeGain;
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
  uniform float uHaloPass;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vCull;
  varying float vGlow;

  void main() {
    if (vCull > 0.5) discard; // culled point (e.g. size 0 mid build-anim)
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = dot(c, c); // squared distance from center, [0, 0.5] inside disc
    if (d > 0.25) discard;
    // Anti-aliased edge over the outer ~4% of the radius.
    float alpha = smoothstep(0.25, 0.2304, d) * vAlpha;
    vec3 color = vColor;
    if (vGlow > 0.5) {
      // Highlighted (chat/search): brightened solid core + a soft halo that
      // fills the enlarged point (NODE_SIZE_HIGHLIGHTED_SCALE gives it room),
      // so highlights read as glowing beacons instead of flat discs.
      //
      // The two parts render in SEPARATE passes. The main pass (uHaloPass=0,
      // depthWrite ON) draws only the solid core: a translucent halo that
      // writes depth blanks every edge behind it — the "dark ring around
      // glowing nodes over edges" bug. The halo pass (uHaloPass=1, depthWrite
      // OFF, drawn after edges) blends the soft glow over whatever is behind.
      float core = 1.0 - smoothstep(0.055, 0.1, d); // solid center ~2/3 radius
      float halo = 1.0 - smoothstep(0.0, 0.25, d); // falloff to the rim
      color = min(vColor * (1.0 + 0.65 * core), vec3(1.0));
      if (uHaloPass > 0.5) {
        // Halo only — exclude the core so an edge passing in FRONT of the
        // node (drawn before this pass) isn't painted over by a second core.
        alpha = halo * halo * 0.65 * (1.0 - core) * vAlpha;
      } else {
        alpha = core * vAlpha;
      }
    } else if (uHaloPass > 0.5) {
      discard; // halo pass draws highlighted nodes only
    }
    // Nearly-invisible fragments must not WRITE DEPTH: the core edge (and the
    // AA rim) tapers to ~0 alpha, and with depthWrite on those pixels blanked
    // everything behind them — a black orb around highlighted/hovered nodes.
    if (alpha < 0.03) discard;
    if (uUseTexture > 0.5) {
      vec4 tex = texture2D(uTexture, gl_PointCoord);
      gl_FragColor = vec4(color * tex.rgb, alpha * tex.a);
    } else {
      gl_FragColor = vec4(color, alpha);
    }
  }
`;

export interface NodeMaterialUniforms {
  uZoom: { value: number };
  uPixelRatio: { value: number };
  uSizeExp: { value: number };
  uPerspective: { value: number };
  uHlScale: { value: number };
  uHlAlpha: { value: number };
  uDimScale: { value: number };
  uDimAlpha: { value: number };
  uTexture: { value: Texture | null };
  uUseTexture: { value: number };
  uHaloPass: { value: number };
}

export function createNodeMaterial(
  pixelRatio: number,
  opts: {
    hlScale: number;
    hlAlpha: number;
    dimScale: number;
    dimAlpha: number;
    /** Halo overlay pass for highlighted nodes: no depth write, drawn after
     *  edges so the translucent glow blends over them instead of depth-killing
     *  them (the "dark ring over edges" bug). */
    haloPass?: boolean;
  },
): ShaderMaterial {
  const haloPass = opts.haloPass ?? false;
  return new ShaderMaterial({
    uniforms: {
      uZoom: { value: 1 },
      uPixelRatio: { value: pixelRatio },
      uSizeExp: { value: 0.2 },
      uPerspective: { value: 0 },
      uHlScale: { value: opts.hlScale },
      uHlAlpha: { value: opts.hlAlpha },
      uDimScale: { value: opts.dimScale },
      uDimAlpha: { value: opts.dimAlpha },
      uTexture: { value: null },
      uUseTexture: { value: 0 },
      uHaloPass: { value: haloPass ? 1 : 0 },
    } satisfies NodeMaterialUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    // Kept transparent so the anti-aliased disc rim still blends, but depth
    // test + write are on so a nearer node properly occludes a farther one in
    // 3D (the "see-through" report). Node bodies are opaque (alpha 1.0), so the
    // only blended pixels are the ~1px rim — the depth halo there is negligible.
    // The halo pass must NOT write depth: its whole output is translucent.
    transparent: true,
    depthTest: true,
    depthWrite: !haloPass,
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
    bool hovered = (state & 8) == 8;
    vPick = aPickColor;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    float sizeMul = highlighted ? uHlScale : (dimmed ? uDimScale : 1.0);
    // Mirror the display shader's hover growth so the grown disc stays
    // clickable across its whole visible area (1.3 = NODE_HOVER_SCALE).
    if (hovered) sizeMul *= 1.3;
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
      // Keep in lockstep with the display shader's 2D sizing (see above):
      // uZoom is the fit-normalized ortho zoom, size gain mirrors 3D.
      float zoomCue = mix(1.0, uZoom, 0.5);
      float sizeGain = pow(12.0, 0.3 - uSizeExp);
      screenPx = base * 2.0 * uPixelRatio * zoomCue * sizeGain;
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
      uSizeExp: { value: 0.2 },
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
