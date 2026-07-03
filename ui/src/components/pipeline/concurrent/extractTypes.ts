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
 * Message protocol between the main thread and the extract worker pool.
 * All payloads are structured-cloneable (no tree-sitter AST nodes cross the
 * boundary — the worker walks the AST and returns only plain extraction data).
 */

import type { CodeSymbol } from '../types';
import type { ImportAnalysisResult } from '../parser/importAnalyzer';

/** Sent once per worker at startup — repo-constant lookups + grammar keys. */
export interface ExtractInitMsg {
  type: 'init';
  knownPaths: Set<string>;
  goModulePath?: string;
  /** Parser keys (from PARSER_WASM_MAP) to load; omit to load all. */
  parserKeys?: string[];
}

/** Request to parse + extract one file. */
export interface ExtractRequestMsg {
  type: 'extract';
  jobId: number;
  fileId: string;
  filePath: string;
  content: string;
}

export type ExtractWorkerIn = ExtractInitMsg | ExtractRequestMsg;

export interface ExtractReadyMsg {
  type: 'ready';
}

/** Successful extraction — serializable symbols + import analysis. */
export interface ExtractResultMsg {
  type: 'result';
  jobId: number;
  fileId: string;
  language: string;
  symbols: CodeSymbol[];
  importResult: ImportAnalysisResult;
}

/** File was not parseable (no language/parser) or produced no tree. */
export interface ExtractSkipMsg {
  type: 'skip';
  jobId: number;
  fileId: string;
}

export interface ExtractErrorMsg {
  type: 'error';
  jobId: number;
  fileId: string;
  error: string;
}

export type ExtractWorkerOut =
  | ExtractReadyMsg
  | ExtractResultMsg
  | ExtractSkipMsg
  | ExtractErrorMsg;
