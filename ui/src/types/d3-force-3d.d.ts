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
 * Type stubs for `d3-force-3d` (ships no types). The API mirrors `d3-force`,
 * with an extra `numDimensions` argument to `forceSimulation` and a `forceZ`.
 * Node/link datums gain z/vz/fz. We re-use d3-force's types where they match
 * and add the 3D extras.
 */
declare module 'd3-force-3d' {
  export {
    forceCollide,
    forceLink,
    forceManyBody,
    forceRadial,
    forceX,
    forceY,
    type Force,
    type Simulation,
    type SimulationNodeDatum,
    type SimulationLinkDatum,
  } from 'd3-force';

  import type {
    Force,
    ForceCenter,
    Simulation,
    SimulationNodeDatum,
    SimulationLinkDatum,
  } from 'd3-force';

  /** d3-force-3d's forceCenter accepts a z coordinate as well. */
  export function forceCenter<NodeDatum extends SimulationNodeDatum>(
    x?: number,
    y?: number,
    z?: number,
  ): ForceCenter<NodeDatum>;

  /** Like d3-force's forceSimulation but accepts the dimension count (1–3). */
  export function forceSimulation<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum> | undefined = undefined,
  >(
    nodes?: NodeDatum[],
    numDimensions?: number,
  ): Simulation<NodeDatum, LinkDatum>;

  export interface ForceZ<NodeDatum extends SimulationNodeDatum> extends Force<
    NodeDatum,
    undefined
  > {
    strength(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    strength(
      strength:
        | number
        | ((d: NodeDatum, i: number, data: NodeDatum[]) => number),
    ): this;
    z(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    z(
      z: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number),
    ): this;
  }

  export function forceZ<NodeDatum extends SimulationNodeDatum>(
    z?: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number),
  ): ForceZ<NodeDatum>;
}
