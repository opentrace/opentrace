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
 * ShaderMaterial for the edge line set.
 *
 * All edges render as a single THREE.LineSegments over one BufferGeometry
 * (2 verts/edge) → one draw call. Per-vertex color + alpha let us express the
 * default / highlighted / dimmed / hidden states without rebuilding geometry:
 * only the small alpha attribute is re-uploaded on a highlight or filter
 * change; endpoint positions stream from the layout worker like the nodes.
 *
 * Lines are straight at every scale (matches the Pixi renderer's behavior past
 * ~5k nodes — the regime that matters for 100k). GPU line width is driver-
 * dependent (effectively 1px), which is the correct, cheap choice at scale;
 * fat lines (Line2/LineMaterial) are a possible follow-up for small graphs.
 */

import { ShaderMaterial, NormalBlending } from 'three';

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  uniform float uDepthBias;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    // 3D: edge endpoints sit exactly AT node centers, so with LessEqual depth
    // the line paints across the node disc ("edges shining through nodes").
    // Push edges slightly away from the camera IN VIEW SPACE (world units) so
    // the disc wins at its own depth while genuinely-in-front edges still
    // draw. Must NOT be a clip-space offset: perspective NDC depth is so
    // nonlinear that even a tiny clip-space bias shoves most edges past the
    // far plane and they vanish. 0 in 2D (depth test is off there).
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    mv.z -= uDepthBias;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float a = vAlpha * uOpacity;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

export function createEdgeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    // uOpacity is a global multiplier the renderer drives by zoom: faint at the
    // overview (clusters read clearly), opaque when zoomed into a region.
    // uDepthBias is set by applyEdgeDepthMode: ~1.5e-3 in 3D, 0 in 2D.
    uniforms: { uOpacity: { value: 1 }, uDepthBias: { value: 0 } },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: NormalBlending,
  });
}
