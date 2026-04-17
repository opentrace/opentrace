# Pixi Renderer

WebGL graph visualization using Pixi.js v8 + d3-force layout. Renders thousands of nodes as sprite batches with worker-offloaded physics.

## Files

```
PixiRenderer.ts         — Core scene graph: sprite batching, edge drawing, quadtree hover
PixiControlPanel.tsx    — Layout mode / zoom controls UI
usePixiLayout.ts        — React bridge to layout worker (manages message passing)
scaleBreakpoints.ts     — Responsive label/edge visibility thresholds
spriteTextures.ts       — Per-color texture atlas generation
viewport.ts             — Camera transform (zoom/pan state)
```

## Architecture

- **Sprite batching** — One `Container` per node color; one circle texture per color. Adding a node = adding a sprite to its color's container. This keeps draw calls O(colors) not O(nodes).
- **Edge throttling** — Edges re-render at max 10fps; during zoom, edges are hidden entirely until the gesture finishes. This prevents expensive line redraws from blocking panning.
- **Quadtree hover** — O(log n) hover detection via a spatial index rebuilt on each position update. Don't do hit-testing via Pixi's built-in `interactive` (it's O(n) at scene scale).
- **Labels** — Rendered only above `LABEL_RENDERED_SIZE_THRESHOLD` zoom level (see `scaleBreakpoints.ts`). Below that, labels are removed from the scene graph entirely — not just hidden.

## Layout Worker Protocol

`pixiLayoutWorker` is a **persistent** worker (lives for the session). Messages:

| Message | Direction | Payload | Notes |
|---|---|---|---|
| `init` | Main → Worker | nodes, links, config | Returns initial positions after N sync ticks |
| `positions` | Worker → Main | `Float64Array` (transferable) | Streamed every ~66ms (15fps) |
| `fix-node` / `unfix-node` | Main → Worker | node id, x/y | Dragging support |
| `set-layout-mode` | Main → Worker | `'spread'` or `'compact'` | Switches force preset |

### Transferable Buffer Lifecycle

Positions arrive as a `Float64Array` whose **ownership** transfers on `postMessage`. The receiving code must:
1. **Copy** the buffer into React state (or a local snapshot)
2. Not mutate the transferred buffer (it's neutered on the sender side)

Mutating without copying causes stale/corrupt position data — this is the #1 gotcha in this module.

## Adding Visual Features

- **New node shapes** — add a texture to `spriteTextures.ts`, then assign it in `PixiRenderer.ts`'s node-setup logic. All nodes of a type share the texture.
- **New edge styles** — modify the edge drawing loop in `PixiRenderer.ts`. Edges are `Graphics` objects, not sprites — they're redrawn every frame, so keep the draw calls minimal.
- **Interaction** — all hit-testing should use the quadtree, not Pixi `interactive`.

## Pitfalls

- **PixiRenderer.ts is ~72KB.** It's large because it's a self-contained scene graph manager. Resist extracting small helpers — they'll just create coupling without reducing complexity.
- **Worker URL resolution.** Rollup can't resolve worker imports from pre-built library bundles. Vite aliases in `vite.config.ts` force source-level resolution — don't change those aliases without testing production builds.
- **Memory leaks.** Pixi textures must be explicitly destroyed. If you add new textures or containers, add cleanup in the `destroy()` method.
