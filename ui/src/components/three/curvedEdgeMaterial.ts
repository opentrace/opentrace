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
 * ShaderMaterial for rendering ALL bulk edges as gentle curves instead of
 * straight 1px rays — the organic look, applied graph-wide.
 *
 * The trick: the geometry is INSTANCED. A single small template line strip
 * (2·(segments−1) verts carrying a `aT` curve parameter) is drawn once per edge
 * as an instance; the edge's two endpoints + colour + alpha arrive as per-
 * instance attributes that alias the SAME Float32Arrays the straight edge set
 * already fills (edgePos / edgeColor / edgeAlpha). The vertex shader evaluates a
 * quadratic bezier — bowed the same way as the hot-edge ribbon so a highlighted
 * edge's glow overlays its curve — so there is NO extra CPU work per frame: the
 * curve is generated entirely on the GPU, one draw call for every edge.
 *
 * Fragment matches edgeMaterial exactly (uOpacity multiplier + the aAlpha∈(1,2]
 * absolute-alpha encoding) so opacity/zoom-fade behave identically to the
 * straight edges it replaces.
 */

import { ShaderMaterial, NormalBlending } from 'three';

const VERTEX_SHADER = /* glsl */ `
  attribute float aT;      // curve parameter [0,1] for this template vertex
  attribute vec3 iA;       // edge start (per-instance)
  attribute vec3 iB;       // edge end (per-instance)
  attribute vec3 iColor;   // per-instance colour
  attribute float iAlpha;  // per-instance alpha

  uniform float uSag;      // bow as a fraction of edge length
  uniform float uMode3d;   // 1.0 = 3D (bow horizontally), 0.0 = 2D (bow in-plane)
  uniform float uDepthBias;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = iColor;
    vAlpha = iAlpha;

    vec3 d = iB - iA;
    float len = length(d);
    vec3 dn = len > 1e-5 ? d / len : vec3(1.0, 0.0, 0.0);
    // Perpendicular for the bow: in-plane in 2D; a stable horizontal arc in 3D
    // (cross(dir, up), falling back to cross(dir, right) when near-vertical).
    vec3 perp;
    if (uMode3d < 0.5) {
      perp = vec3(-dn.y, dn.x, 0.0);
    } else {
      perp = vec3(-dn.z, 0.0, dn.x);
      if (dot(perp, perp) < 1e-4) perp = vec3(0.0, dn.z, -dn.y);
    }
    perp = normalize(perp);
    vec3 C = (iA + iB) * 0.5 + perp * len * uSag;

    float t = aT;
    float u = 1.0 - t;
    vec3 P = u * u * iA + 2.0 * u * t * C + t * t * iB;

    vec4 mv = modelViewMatrix * vec4(P, 1.0);
    mv.z -= uDepthBias; // match edgeMaterial's 3D depth push
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // Identical to edgeMaterial: aAlpha in (1,2] is ABSOLUTE (bypasses the
    // global zoom/user opacity) for hot edges; otherwise scale by uOpacity.
    float a = vAlpha > 1.0 ? min(vAlpha - 1.0, 1.0) : vAlpha * uOpacity;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

export interface CurvedEdgeMaterialUniforms {
  uOpacity: { value: number };
  uSag: { value: number };
  uMode3d: { value: number };
  uDepthBias: { value: number };
}

export function createCurvedEdgeMaterial(sag: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uOpacity: { value: 1 },
      uSag: { value: sag },
      uMode3d: { value: 0 },
      uDepthBias: { value: 0 },
    } satisfies CurvedEdgeMaterialUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: NormalBlending,
  });
}
