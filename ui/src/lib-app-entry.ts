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
 * Library build entry for the ./app export.
 *
 * Imports app-level CSS so Vite extracts it into opentrace.css at build time.
 * Source consumers import OpenTraceApp.tsx directly (no CSS side effects) to
 * avoid crashes in hosts using hydrateRoot(document).
 */
import './styles/index.css';
import './App.css';

export { default as OpenTraceApp } from './OpenTraceApp';
export type { OpenTraceAppProps } from './OpenTraceApp';
