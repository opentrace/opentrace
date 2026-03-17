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

import type { GraphNode, GraphRelationship, Store } from '../types';

export class MemoryStore implements Store {
  readonly nodes = new Map<string, GraphNode>();
  readonly relationships = new Map<string, GraphRelationship>();

  saveNode(node: GraphNode): void {
    const existing = this.nodes.get(node.id);
    if (existing) {
      // Merge properties (e.g. summary update into existing node)
      existing.properties = {
        ...existing.properties,
        ...(node.properties ?? {}),
      };
    } else {
      this.nodes.set(node.id, node);
    }
  }

  saveRelationship(rel: GraphRelationship): void {
    this.relationships.set(rel.id, rel);
  }
}
