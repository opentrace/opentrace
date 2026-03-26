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

import { StoreProvider } from './store';
import { JobServiceProvider } from './job';
import App from './App';

export interface OpenTraceAppProps {
  /** Shown in the version footer (bottom-right). Omit to hide the footer. */
  version?: string;
  /** Build timestamp shown in the version footer. Omit to hide. */
  buildTime?: string;
  /** Initial repository URL to index or open. */
  repoUrl?: string;
}

/**
 * Drop-in full OpenTrace application component.
 *
 * Includes all providers, styles, and the complete UI — graph canvas, chat
 * panel, settings drawer, and indexing.
 *
 * Usage:
 *   import { OpenTraceApp } from '@opentrace/opentrace/app';
 *   import '@opentrace/opentrace/style.css';
 *
 *   <OpenTraceApp />
 *
 * Note: requires Cross-Origin Isolation headers (COOP/COEP) for the
 * in-browser WASM graph store.
 */
export function OpenTraceApp({
  version,
  buildTime,
  repoUrl,
}: OpenTraceAppProps = {}) {
  return (
    <StoreProvider>
      <JobServiceProvider>
        <App version={version} buildTime={buildTime} initialRepoUrl={repoUrl} />
      </JobServiceProvider>
    </StoreProvider>
  );
}

export default OpenTraceApp;
