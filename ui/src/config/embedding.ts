import type { EmbedderConfig } from "../runner/browser/enricher/embedder/types";
import { DEFAULT_EMBEDDER_CONFIG } from "../runner/browser/enricher/embedder/types";

const ENABLED_KEY = "ot_embedding_enabled";
const MODEL_KEY = "ot_embedding_model";

export function loadEmbedderConfig(): EmbedderConfig {
  const stored = localStorage.getItem(ENABLED_KEY);
  const enabled = stored === null ? DEFAULT_EMBEDDER_CONFIG.enabled : stored === "true";
  const model =
    localStorage.getItem(MODEL_KEY) || DEFAULT_EMBEDDER_CONFIG.model;
  return { enabled, model };
}
