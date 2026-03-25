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
import { Graphics, type Application, type Texture } from 'pixi.js';

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

const GLOW_RADIUS = 48; // outer radius of the glow texture
const GLOW_RINGS = 8; // number of concentric rings to simulate gradient

/**
 * Get (or create) a soft glow texture for the given hex color.
 * Draws concentric filled circles with decreasing alpha to simulate a radial gradient.
 */
export function getGlowTexture(
  app: Application,
  color: string,
  cache: Map<string, Texture>,
): Texture {
  const key = `glow:${color}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const g = new Graphics();
  // Draw rings from outer (faint) to inner (bright) so inner overwrites outer
  for (let i = GLOW_RINGS; i >= 0; i--) {
    const t = i / GLOW_RINGS; // 1 = outermost, 0 = center
    const r = GLOW_RADIUS * (0.3 + 0.7 * t); // rings from 30% to 100% of radius
    const alpha = 0.5 * (1 - t); // 0 at edge, 0.5 at center
    g.circle(GLOW_RADIUS, GLOW_RADIUS, r);
    g.fill({ color, alpha });
  }
  const tex = app.renderer.generateTexture(g);
  g.destroy();
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
