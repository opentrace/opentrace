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

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { OpenTraceApp } from './OpenTraceApp';

const root = document.getElementById('root')!;

if (!window.crossOriginIsolated) {
  root.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif;color:#888;text-align:center;padding:2rem">' +
    '<div>' +
    '<h1 style="font-size:1.25rem;margin-bottom:0.5rem">Browser Not Supported</h1>' +
    '<p style="font-size:0.875rem">OpenTrace requires a modern browser with cross-origin isolation support.</p>' +
    '<p style="font-size:0.875rem;margin-top:0.5rem"><a href="https://opentrace.github.io/opentrace/reference/browser-requirements/" style="color:#6ea8fe">Learn more</a></p>' +
    '</div>' +
    '</div>';
} else {
  createRoot(root).render(
    <StrictMode>
      <OpenTraceApp version={__APP_VERSION__} buildTime={__BUILD_TIME__} />
    </StrictMode>,
  );
}
