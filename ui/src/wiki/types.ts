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

export type VaultScope = 'local' | 'global';

export interface VaultEntry {
  name: string;
  scope: VaultScope;
  /** For ``view=project``: always true (local vaults are project-resident
   *  and globals only appear here once attached). For ``view=global``:
   *  true when the global vault is mirrored into the current project. */
  attached: boolean;
}

/** Concept pages are the only page kind. Legacy vaults may carry other
 *  values (``"file_summary"``, ``"source_summary"``, ``"source"``) but the
 *  UI treats every page as a concept regardless. */
export type VaultPageKind = 'concept';

export interface VaultPageMeta {
  slug: string;
  title: string;
  one_line_summary: string;
  revision: number;
  last_updated: string;
  /** Old vaults may lack this field; treat absent as "concept". */
  kind?: VaultPageKind;
}

export interface VaultDetail {
  name: string;
  last_compiled_at: string | null;
  pages: VaultPageMeta[];
}

export type WikiPhase =
  | 'acquiring'
  | 'normalizing'
  | 'planning'
  | 'executing'
  | 'persisting';

export interface WikiCompileEvent {
  kind: 'stage_start' | 'stage_progress' | 'stage_stop' | 'done' | 'error';
  phase: WikiPhase;
  message: string;
  current?: number;
  total?: number;
  file_name?: string | null;
  detail?: Record<string, unknown> | null;
  errors?: string[] | null;
}
