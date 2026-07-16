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
 * ShaderMaterial for the HOT (highlighted / chat-traversal) edges — rendered as
 * soft, glowing, camera-facing ribbons instead of the bulk edges' hard 1px GL
 * lines. This is what makes a chat highlight read as organic strands of light
 * rather than a straight vector-graphic star of rays.
 *
 * Geometry (built on the CPU in ThreeRenderer): each hot edge is a quadratic
 * bezier bowed in world space, tessellated into sample points; every sample
 * emits two vertices (`aSide` = ±1) so the pair straddles the curve. The ribbon
 * is expanded to a CONSTANT PIXEL WIDTH in clip space here (the MeshLine
 * technique) — so it faces the screen and stays readable at any zoom/orbit
 * WITHOUT any per-camera CPU rebuild. The fragment shader fades the alpha across
 * the width (bright core → transparent rim) and blends ADDITIVELY, so where
 * strands cross their glow sums like real light.
 */

import { ShaderMaterial, AdditiveBlending, DoubleSide } from 'three';

const VERTEX_SHADER = /* glsl */ `
  attribute float aSide;      // -1 / +1 : which side of the curve this vert sits
  attribute vec3 aTangent;    // curve tangent at this sample (world space)
  attribute vec3 aColor;
  attribute float aAlpha;     // per-vertex glow strength (tapers to 0 at the ends)

  uniform float uHalfWidth;   // ribbon half-width in WORLD units

  varying float vAcross;      // signed position across the ribbon, [-1, 1]
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vAcross = aSide;

    // Offset the vertex in VIEW space, in the screen-parallel plane,
    // perpendicular to the tangent — a camera-facing ribbon of constant WORLD
    // width. Because the width is world-scaled (not a fixed pixel count), the
    // strands shrink along with the graph as you zoom out, instead of staying
    // fat and piling their additive glow into one saturated blob.
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 tan = (modelViewMatrix * vec4(aTangent, 0.0)).xyz;
    vec2 t2 = tan.xy;
    float l = length(t2);
    t2 = l > 1e-5 ? t2 / l : vec2(1.0, 0.0);
    vec2 n2 = vec2(-t2.y, t2.x); // perpendicular in the view XY (screen) plane
    mv.xy += n2 * aSide * uHalfWidth;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying float vAcross;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // Soft falloff across the ribbon width: bright at the centreline, fading to
    // nothing at the rim — a glowing filament, not a flat stroke.
    float edge = 1.0 - abs(vAcross);
    float glow = pow(max(edge, 0.0), 2.0); // steeper falloff → slimmer bright core
    float core = smoothstep(0.6, 1.0, edge); // brighter inner strand
    vec3 color = min(vColor + core * 0.35, vec3(1.0));
    float a = glow * vAlpha;
    if (a < 0.004) discard; // additive: near-zero fragments add nothing
    gl_FragColor = vec4(color, a);
  }
`;

export interface HotEdgeMaterialUniforms {
  uHalfWidth: { value: number };
}

export function createHotEdgeMaterial(halfWidth: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uHalfWidth: { value: halfWidth },
    } satisfies HotEdgeMaterialUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    // Additive so overlapping strands bloom together like light. depthTest is
    // OFF: a highlight's strands should read as a continuous glowing filament,
    // not blink in and out as each one sweeps behind the node cloud while the
    // scene rotates (the "appear and disappear" flicker). DoubleSide because the
    // screen-facing ribbon's winding flips with the curve direction — FrontSide
    // would cull half the strands. Never writes depth (translucent glow).
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}
