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

// Pipeline orchestrator
export { runPipeline, collectPipeline, initParsers } from './pipeline';

// Types
export type {
  PipelineContext,
  PipelineEventKind,
  PipelinePhase,
  ProgressDetail,
  PipelineResult,
  PipelineEvent,
  RepoFile,
  RepoTree,
  GraphNode,
  GraphRelationship,
  CallRef,
  CodeSymbol,
  ExtractionResult,
  LoadingInput,
  ScanResult,
  ProcessingOutput,
  ParsingFileResult,
  ParserMap,
  Store,
} from './types';

// Store
export { MemoryStore } from './store/memory';

// Parser utilities
export { extractPython } from './parser/extractors/python';
export { extractTypeScript } from './parser/extractors/typescript';
export { extractGo } from './parser/extractors/go';
export { extractGeneric } from './parser/extractors/generic';
export {
  resolveCalls,
  resolvedCallsToRelationships,
} from './parser/callResolver';
export type {
  SymbolNode,
  Registries,
  CallInfo,
  ResolvedCall,
} from './parser/callResolver';
export {
  analyzeImports,
  analyzePythonImports,
  analyzeGoImports,
  analyzeTypeScriptImports,
  analyzeRustImports,
  analyzeRubyImports,
  resetDirIndexCache,
} from './parser/importAnalyzer';
export type { ImportAnalysisResult } from './parser/importAnalyzer';
export {
  isManifestFile,
  parseManifest,
  parsePackageJson,
  parseGoMod,
  parseRequirementsTxt,
  parsePyprojectToml,
  parseCargoToml,
  packageId,
  packageSourceUrl,
  npmPackageName,
  normalizePyName,
} from './parser/manifestParser';
export type {
  ParsedDependency,
  ManifestParseResult,
} from './parser/manifestParser';

// Summarizer
export {
  summarizeFromMetadata,
  summarizeFunction,
  summarizeClass,
  summarizeFile,
  summarizeDirectory,
  splitIdentifier,
  extractKeywords,
  TemplateSummarizer,
} from './summarizer/templateSummarizer';
export type {
  NodeKind,
  SummarizationStrategyType,
  SymbolMetadata,
  SummarizerConfig,
  Summarizer,
} from './summarizer/types';
export { DEFAULT_SUMMARIZER_CONFIG } from './summarizer/types';

// Stage helpers (useful for tests)
export {
  parseFile,
  getExtractor,
  getParserForLanguage,
  processSymbol,
  countSymbols,
  addToRegistry,
} from './stages/parsing';
export {
  getExtension,
  detectLanguage,
  parentDir,
  ensureDirChain,
} from './stages/loading';

// WASM file helpers are in ./wasm — import separately to avoid pulling
// Node.js builtins into browser bundles:
//
//   import { getWasmDir, getWasmPath } from '@opentrace/components/pipeline/wasm';
