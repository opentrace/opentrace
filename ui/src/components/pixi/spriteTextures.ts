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
 * Sprite texture cache for Pixi.js graph nodes.
 *
 * Creates one PIXI.Texture per unique color, shared across all nodes of that
 * color. This enables sprite batching — Pixi draws all same-texture sprites
 * in a single GPU draw call.
 */
import { Graphics, Texture, type Application } from 'pixi.js';

const CIRCLE_RADIUS = 16; // texture size in pixels (sprites scale via .scale)

/**
 * Get (or create) a circle texture for the given hex color string.
 * The color should be a CSS hex string like '#3b82f6'.
 *
 * @param cache - Per-renderer texture cache map. Each PixiRenderer instance
 *   owns its own cache so that clearing it on destroy doesn't break other
 *   live renderers.
 */
export function getCircleTexture(
  app: Application,
  color: string,
  cache: Map<string, Texture>,
): Texture {
  const cached = cache.get(color);
  if (cached) return cached;

  const g = new Graphics();
  g.circle(CIRCLE_RADIUS, CIRCLE_RADIUS, CIRCLE_RADIUS);
  g.fill({ color });
  const tex = app.renderer.generateTexture(g);
  g.destroy();
  cache.set(color, tex);
  return tex;
}

const GLOW_RADIUS = 48; // outer radius of the glow texture (texture is 2× this)

/** Parse a CSS hex color (#rgb or #rrggbb) into 0–255 channels. */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Get (or create) a soft glow texture for the given hex color.
 *
 * Uses a real canvas radial gradient rather than stacked concentric
 * circles — the old ring approach left visible alpha banding ("layers")
 * when the glow was scaled up. The gradient falls off smoothly from a
 * bright center to a fully transparent edge.
 *
 * `_app` is unused (the texture is built from a canvas, not the renderer)
 * but kept for signature parity with the other texture helpers.
 */
export function getGlowTexture(
  _app: Application,
  color: string,
  cache: Map<string, Texture>,
): Texture {
  const key = `glow:${color}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const size = GLOW_RADIUS * 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const { r, g, b } = parseHexColor(color);
  const grad = ctx.createRadialGradient(
    GLOW_RADIUS,
    GLOW_RADIUS,
    0,
    GLOW_RADIUS,
    GLOW_RADIUS,
    GLOW_RADIUS,
  );
  // Smooth multi-stop falloff — center is brightest, edge fully clear.
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.5)`);
  grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.16)`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = Texture.from(canvas);
  cache.set(key, tex);
  return tex;
}

/** Clear and destroy all textures in the given cache. */
export function clearTextureCache(cache: Map<string, Texture>): void {
  for (const tex of cache.values()) {
    tex.destroy(true);
  }
  cache.clear();
}

export { CIRCLE_RADIUS };
