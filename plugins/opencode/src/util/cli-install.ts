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
 * Install guidance returned from a tool call when the opentraceai CLI is
 * not on PATH. The system-prompt hook deliberately omits this — see
 * `src/hooks/system-prompt.ts` — so install guidance only reaches the LLM
 * when it actually invokes a tool that needs the CLI.
 */
export function getCliMissingMessage(): string {
  return [
    "OpenTrace tools are unavailable: no working `opentraceai` CLI was found.",
    "",
    "Install with one of:",
    "  uv tool install opentraceai      # if uv is available",
    "  pipx install opentraceai         # alternative",
    "",
    "Once installed the tools become available on the next message - no",
    "restart required.",
    "",
    "Ask the user before running an install command on their behalf.",
  ].join("\n")
}
