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
 * Full-screen post-processing materials for the depth-of-field effect used when
 * a highlight is active: the (dimmed) background is rendered to a texture, blurred
 * here, composited to screen, then the highlighted set is drawn sharp on top — so
 * the rest of the graph reads as genuinely out of focus rather than merely faded.
 *
 * Both use a full-screen-quad vertex shader that emits clip coordinates directly
 * (camera-independent). The blur is a separable 9-tap gaussian run once per axis.
 */

import { ShaderMaterial } from 'three';

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uDir; // texel step * blur radius, along one axis
  varying vec2 vUv;
  void main() {
    // Separable gaussian, 9 taps (weights sum to 1).
    vec4 c = texture2D(uTex, vUv) * 0.2270270270;
    c += texture2D(uTex, vUv + uDir * 1.0) * 0.1945945946;
    c += texture2D(uTex, vUv - uDir * 1.0) * 0.1945945946;
    c += texture2D(uTex, vUv + uDir * 2.0) * 0.1216216216;
    c += texture2D(uTex, vUv - uDir * 2.0) * 0.1216216216;
    c += texture2D(uTex, vUv + uDir * 3.0) * 0.0540540541;
    c += texture2D(uTex, vUv - uDir * 3.0) * 0.0540540541;
    c += texture2D(uTex, vUv + uDir * 4.0) * 0.0162162162;
    c += texture2D(uTex, vUv - uDir * 4.0) * 0.0162162162;
    gl_FragColor = c;
  }
`;

const COPY_FRAGMENT = /* glsl */ `
  uniform sampler2D uTex;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(uTex, vUv);
  }
`;

export interface BlurMaterialUniforms {
  uTex: { value: import('three').Texture | null };
  uDir: { value: [number, number] };
}

export function createBlurMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTex: { value: null },
      uDir: { value: [0, 0] },
    } satisfies BlurMaterialUniforms,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: BLUR_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
}

export function createCopyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTex: { value: null } },
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: COPY_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
}
