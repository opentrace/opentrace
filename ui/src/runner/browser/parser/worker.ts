/**
 * Web Worker entry point for browser-based code indexing (parse only).
 *
 * Initializes web-tree-sitter WASM parsers, receives repo data,
 * runs the extraction pipeline, and posts batches + enrichment items
 * back to the main thread. ML enrichment runs in a separate worker.
 */

import { Parser, Language } from "web-tree-sitter";
import { runPipeline } from "./pipeline";
import { createStrategy, type SummarizationStrategy } from "../enricher/summarizer/strategy";
import { DEFAULT_SUMMARIZER_CONFIG } from "../enricher/summarizer/types";
import type { SummarizerConfig } from "../enricher/summarizer/types";
import type { IndexPhase, WorkerRequest, WorkerResponse, RepoTree } from "../types";

let pythonParser: Parser | undefined;
let tsParser: Parser | undefined;
let tsxParser: Parser | undefined;
let goParser: Parser | undefined;
let cancelled = false;
let summarizationStrategy: SummarizationStrategy | undefined;

function post(msg: WorkerResponse) {
  self.postMessage(msg);
}

async function initParsers() {
  await Parser.init({
    locateFile: (scriptName: string) => `/${scriptName}`,
  });

  const [pythonLang, tsLang, tsxLang, goLang] = await Promise.all([
    Language.load("/tree-sitter-python.wasm"),
    Language.load("/tree-sitter-typescript.wasm"),
    Language.load("/tree-sitter-tsx.wasm"),
    Language.load("/tree-sitter-go.wasm"),
  ]);

  pythonParser = new Parser();
  pythonParser.setLanguage(pythonLang);

  tsParser = new Parser();
  tsParser.setLanguage(tsLang);

  tsxParser = new Parser();
  tsxParser.setLanguage(tsxLang);

  goParser = new Parser();
  goParser.setLanguage(goLang);
}

async function handleIndex(repo: RepoTree) {
  console.log(`[ParseWorker] handleIndex: ${repo.owner}/${repo.repo}, ${repo.files.length} files, strategy=${summarizationStrategy?.type}`);
  try {
    const result = await runPipeline(repo, {
      python: pythonParser,
      typescript: tsParser,
      tsx: tsxParser,
      go: goParser,
    }, {
      onProgress: (phase, message, current, total, fileName) => {
        if (cancelled) return;
        post({
          type: "progress",
          phase: phase as IndexPhase,
          message,
          detail: { current, total, fileName },
        });
      },
      onBatch: (batch) => {
        if (cancelled) return;
        post({
          type: "batch",
          nodes: batch.nodes,
          relationships: batch.relationships,
        });
      },
      onStageComplete: (phase, message) => {
        if (cancelled) return;
        post({
          type: "stage-complete",
          phase: phase as IndexPhase,
          message,
        });
      },
    }, summarizationStrategy!);

    if (!cancelled) {
      console.log(`[ParseWorker] pipeline complete: ${result.filesProcessed} files, ${result.nodesCreated} nodes, ${result.relationshipsCreated} rels, ${result.enrichItems.length} enrichItems, ${result.errors.length} errors`);
      if (result.errors.length > 0) {
        console.warn("[ParseWorker] pipeline errors:", result.errors);
      }
      // Send enrichment items to manager for forwarding to the enrichment worker
      if (result.enrichItems.length > 0) {
        post({ type: "enrich-items", items: result.enrichItems });
      }

      post({
        type: "done",
        filesProcessed: result.filesProcessed,
        nodesCreated: result.nodesCreated,
        relationshipsCreated: result.relationshipsCreated,
        errors: result.errors,
      });
    }
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  switch (msg.type) {
    case "init":
      try {
        console.log("[ParseWorker] initializing tree-sitter parsers...");
        await initParsers();
        console.log("[ParseWorker] parsers ready");
        // Create summarization strategy from config (or use template default)
        const config: SummarizerConfig = msg.summarizerConfig
          ? { ...DEFAULT_SUMMARIZER_CONFIG, ...msg.summarizerConfig }
          : DEFAULT_SUMMARIZER_CONFIG;
        console.log(`[ParseWorker] creating strategy: ${config.strategy} (enabled=${config.enabled})`);
        summarizationStrategy = createStrategy(config);
        try {
          console.log(`[ParseWorker] initializing ${config.strategy} strategy...`);
          await summarizationStrategy.init();
          console.log(`[ParseWorker] ${config.strategy} strategy initialized`);
        } catch (strategyErr) {
          // ML strategy init can fail (model download timeout, network error).
          // Fall back to template so parsing still completes.
          const reason = strategyErr instanceof Error ? strategyErr.message : String(strategyErr);
          console.warn(`[ParseWorker] strategy init failed: ${reason}, falling back to template`);
          post({
            type: "progress",
            phase: "initializing" as IndexPhase,
            message: `ML summarizer unavailable (${reason}), using template`,
            detail: { current: 0, total: 1 },
          });
          summarizationStrategy = createStrategy({ ...config, strategy: "template" });
          await summarizationStrategy.init();
        }
        console.log("[ParseWorker] posting ready");
        post({ type: "ready" });
      } catch (err) {
        console.error("[ParseWorker] init failed:", err);
        post({
          type: "error",
          message: `Failed to init parsers: ${err instanceof Error ? err.message : err}`,
        });
      }
      break;

    case "index":
      cancelled = false;
      handleIndex(msg.repo);
      break;

    case "cancel":
      cancelled = true;
      break;
  }
};
