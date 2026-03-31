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

import type { GraphStore } from './types';
import { ServerGraphStore } from './serverStore';
import { createLadybugStore } from './createLadybugStore';

/**
 * Detect a server URL from the `?server=` query parameter.
 *
 * Examples:
 *   http://localhost:5173/?server=http://localhost:8787
 *   http://localhost:5173/?server=https://opentrace.example.com
 */
function detectServerUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('server');
  } catch {
    return null;
  }
}

// Module-level singleton (same pattern as createLadybugStore).
let singleton: GraphStore | null = null;

/**
 * Returns a singleton GraphStore.
 *
 * If `?server=<url>` is present in the page URL, returns a
 * {@link ServerGraphStore} that delegates all queries to the remote
 * `opentrace serve` REST API. Otherwise falls back to the in-browser
 * WASM-backed {@link LadybugGraphStore}.
 */
export function createStore(): GraphStore {
  if (!singleton) {
    const serverUrl = detectServerUrl();
    if (serverUrl) {
      console.info(`[OpenTrace] Server mode — connecting to ${serverUrl}`);
      singleton = new ServerGraphStore(serverUrl);
    } else {
      singleton = createLadybugStore();
    }
  }
  return singleton;
}

// Clean up on Vite HMR
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (singleton && 'dispose' in singleton) {
      (singleton as { dispose: () => void }).dispose();
    }
    singleton = null;
  });
}
