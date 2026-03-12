/**
 * Web Worker entry point for browser-based code indexing (parse only).
 *
 * Initializes web-tree-sitter WASM runtime, lazily loads language parsers
 * based on the repo's file extensions, runs the extraction pipeline,
 * and posts batches + enrichment items back to the main thread.
 */

import { Parser, Language } from 'web-tree-sitter';
import { runPipeline } from './pipeline';
import {
  createStrategy,
  type SummarizationStrategy,
} from '../enricher/summarizer/strategy';
import { DEFAULT_SUMMARIZER_CONFIG } from '../enricher/summarizer/types';
import {
  EXTENSION_LANGUAGE_MAP,
  PARSEABLE_LANGUAGES,
} from '../loader/constants';
import type { SummarizerConfig } from '../enricher/summarizer/types';
import type {
  IndexPhase,
  WorkerRequest,
  WorkerResponse,
  RepoTree,
} from '../types';

/** Maps language name → WASM file path served from public/. */
const LANGUAGE_WASM_MAP: Record<string, string> = {
  python: '/tree-sitter-python.wasm',
  typescript: '/tree-sitter-typescript.wasm',
  tsx: '/tree-sitter-tsx.wasm',
  go: '/tree-sitter-go.wasm',
  rust: '/tree-sitter-rust.wasm',
  java: '/tree-sitter-java.wasm',
  kotlin: '/tree-sitter-kotlin.wasm',
  csharp: '/tree-sitter-c_sharp.wasm',
  c: '/tree-sitter-c.wasm',
  cpp: '/tree-sitter-cpp.wasm',
  ruby: '/tree-sitter-ruby.wasm',
  swift: '/tree-sitter-swift.wasm',
};

let runtimeReady = false;
const parserCache = new Map<string, Parser>();
let cancelled = false;
let summarizationStrategy: SummarizationStrategy | undefined;

function post(msg: WorkerResponse) {
  self.postMessage(msg);
}

/** Initialize the tree-sitter WASM runtime (once). */
async function initTreeSitter() {
  if (runtimeReady) return;
  await Parser.init({
    locateFile: (scriptName: string) => `/${scriptName}`,
  });
  runtimeReady = true;
}

/** Determine which parseable languages are present in the repo. */
function detectLanguages(repo: RepoTree): Set<string> {
  const languages = new Set<string>();
  for (const file of repo.files) {
    const dotIdx = file.path.lastIndexOf('.');
    if (dotIdx < 0) continue;
    const ext = file.path.slice(dotIdx).toLowerCase();
    const lang = EXTENSION_LANGUAGE_MAP[ext];
    if (lang && PARSEABLE_LANGUAGES.has(lang)) {
      languages.add(lang);
      // TSX files need the tsx parser, TS files need typescript parser
      if (lang === 'typescript' && ext === '.tsx') {
        languages.add('tsx');
      }
      // JavaScript uses the tsx parser as a superset
      if (lang === 'javascript') {
        languages.add('tsx');
      }
    }
  }
  // If typescript is present, also ensure tsx is loaded (for .tsx files)
  // and vice versa for JS
  return languages;
}

/** Load parsers for the given languages, reusing cached instances. */
async function loadParsers(
  languages: Set<string>,
): Promise<Map<string, Parser>> {
  const toLoad: string[] = [];
  for (const lang of languages) {
    if (!parserCache.has(lang) && LANGUAGE_WASM_MAP[lang]) {
      toLoad.push(lang);
    }
  }

  if (toLoad.length > 0) {
    const loaded = await Promise.all(
      toLoad.map(async (lang) => {
        const wasmPath = LANGUAGE_WASM_MAP[lang];
        const language = await Language.load(wasmPath);
        const parser = new Parser();
        parser.setLanguage(language);
        return { lang, parser };
      }),
    );
    for (const { lang, parser } of loaded) {
      parserCache.set(lang, parser);
    }
  }

  return parserCache;
}

async function handleIndex(repo: RepoTree) {
  console.log(
    `[ParseWorker] handleIndex: ${repo.owner}/${repo.repo}, ${repo.files.length} files, strategy=${summarizationStrategy?.type}`,
  );
  try {
    // Scan repo to determine which languages are needed, then load only those
    const needed = detectLanguages(repo);
    console.log(`[ParseWorker] detected languages: ${[...needed].join(', ')}`);
    const parsers = await loadParsers(needed);
    console.log(`[ParseWorker] loaded ${parsers.size} parsers`);

    const result = await runPipeline(
      repo,
      parsers,
      {
        onProgress: (phase, message, current, total, fileName) => {
          if (cancelled) return;
          post({
            type: 'progress',
            phase: phase as IndexPhase,
            message,
            detail: { current, total, fileName },
          });
        },
        onBatch: (batch) => {
          if (cancelled) return;
          post({
            type: 'batch',
            nodes: batch.nodes,
            relationships: batch.relationships,
          });
        },
        onStageComplete: (phase, message) => {
          if (cancelled) return;
          post({
            type: 'stage-complete',
            phase: phase as IndexPhase,
            message,
          });
        },
      },
      summarizationStrategy!,
    );

    if (!cancelled) {
      console.log(
        `[ParseWorker] pipeline complete: ${result.filesProcessed} files, ${result.nodesCreated} nodes, ${result.relationshipsCreated} rels, ${result.enrichItems.length} enrichItems, ${result.errors.length} errors`,
      );
      if (result.errors.length > 0) {
        console.warn('[ParseWorker] pipeline errors:', result.errors);
      }
      // Send enrichment items to manager for forwarding to the enrichment worker
      if (result.enrichItems.length > 0) {
        post({ type: 'enrich-items', items: result.enrichItems });
      }

      post({
        type: 'done',
        filesProcessed: result.filesProcessed,
        nodesCreated: result.nodesCreated,
        relationshipsCreated: result.relationshipsCreated,
        errors: result.errors,
      });
    }
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      try {
        console.log('[ParseWorker] initializing tree-sitter runtime...');
        await initTreeSitter();
        console.log('[ParseWorker] runtime ready');
        // Create summarization strategy from config (or use template default)
        const config: SummarizerConfig = msg.summarizerConfig
          ? { ...DEFAULT_SUMMARIZER_CONFIG, ...msg.summarizerConfig }
          : DEFAULT_SUMMARIZER_CONFIG;
        console.log(
          `[ParseWorker] creating strategy: ${config.strategy} (enabled=${config.enabled})`,
        );
        summarizationStrategy = createStrategy(config);
        try {
          console.log(
            `[ParseWorker] initializing ${config.strategy} strategy...`,
          );
          await summarizationStrategy.init();
          console.log(`[ParseWorker] ${config.strategy} strategy initialized`);
        } catch (strategyErr) {
          // ML strategy init can fail (model download timeout, network error).
          // Fall back to template so parsing still completes.
          const reason =
            strategyErr instanceof Error
              ? strategyErr.message
              : String(strategyErr);
          console.warn(
            `[ParseWorker] strategy init failed: ${reason}, falling back to template`,
          );
          post({
            type: 'progress',
            phase: 'initializing' as IndexPhase,
            message: `ML summarizer unavailable (${reason}), using template`,
            detail: { current: 0, total: 1 },
          });
          summarizationStrategy = createStrategy({
            ...config,
            strategy: 'template',
          });
          await summarizationStrategy.init();
        }
        console.log('[ParseWorker] posting ready');
        post({ type: 'ready' });
      } catch (err) {
        console.error('[ParseWorker] init failed:', err);
        post({
          type: 'error',
          message: `Failed to init parsers: ${err instanceof Error ? err.message : err}`,
        });
      }
      break;

    case 'index':
      cancelled = false;
      handleIndex(msg.repo);
      break;

    case 'cancel':
      cancelled = true;
      break;
  }
};
