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
 * Mirror of the `opentraceai` CLI's exit-code contract. The CLI publishes
 * these as a stable interface; consumers map each code to whatever recovery
 * shape fits their UI. Source of truth lives at
 * `opentrace_agent/cli/workspace.py` (`EXIT_*` constants).
 */

export const EXIT_OK = 0
export const EXIT_DB_MISSING = 3
export const EXIT_WORKSPACE_UNRESOLVABLE = 4
export const EXIT_INDEX_IN_PROGRESS = 5

export const DB_MISSING_MESSAGE =
  "No OpenTrace index found. Use opentrace_repo_index to index a repository first."

// Strips the CLI's human-only "remove the lock file" hint so an LLM
// can't race the live writer by deleting it.
export const INDEX_IN_PROGRESS_MESSAGE =
  "Another opentrace_repo_index is currently running in this workspace. " +
  "Wait a few minutes and try again, or use the existing graph via the " +
  "other opentrace_ tools in the meantime."

/**
 * Fact-stating message for an unresolvable workspace directory. Includes the
 * input path so the LLM can echo it back to the user when it has to ask them
 * to fix it.
 */
export function workspaceUnresolvableMessage(directory: string): string {
  return `OpenTrace cannot resolve the current workspace directory. Check that ${directory} exists and is accessible.`
}
