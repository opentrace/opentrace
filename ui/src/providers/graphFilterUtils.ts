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

import type { GraphNode } from '@opentrace/components/utils';

/**
 * Extract a sub-type value from a node based on its type.
 * Returns null if no meaningful sub-type can be derived.
 */
export function getSubType(node: GraphNode): string | null {
  if (node.type === 'File') {
    const name = node.name || node.id;
    const lastDot = name.lastIndexOf('.');
    if (lastDot > 0) return name.slice(lastDot);
    return null;
  }
  if (node.type === 'Function' || node.type === 'Class') {
    const lang = node.properties?.language as string | undefined;
    return lang || null;
  }
  if (node.type === 'Dependency') {
    const registry = node.properties?.registry as string | undefined;
    return registry || null;
  }
  if (node.type === 'Variable') {
    const kind = node.properties?.kind as string | undefined;
    return kind || null;
  }
  return null;
}

/**
 * Extract the string ID from a link endpoint.
 * GraphLink endpoints are always strings in our data model,
 * but we keep this helper for safety.
 */
export function linkId(
  endpoint: string | number | GraphNode | undefined,
): string {
  if (typeof endpoint === 'object' && endpoint !== null) return endpoint.id;
  return String(endpoint);
}
