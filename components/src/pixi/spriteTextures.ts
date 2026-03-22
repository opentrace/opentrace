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

/** Clear and destroy all textures in the given cache. */
export function clearTextureCache(cache: Map<string, Texture>): void {
  for (const tex of cache.values()) {
    tex.destroy(true);
  }
  cache.clear();
}

export { CIRCLE_RADIUS };
