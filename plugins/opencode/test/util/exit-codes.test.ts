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

import { describe, expect, test } from "bun:test"
import {
  DB_MISSING_MESSAGE,
  EXIT_DB_MISSING,
  EXIT_OK,
  EXIT_WORKSPACE_UNRESOLVABLE,
  workspaceUnresolvableMessage,
} from "../../src/util/exit-codes.js"

describe("exit-codes constants", () => {
  test("contract codes match the agent-side EXIT_* values", () => {
    // Source of truth: opentrace_agent/cli/workspace.py.
    expect(EXIT_OK).toBe(0)
    expect(EXIT_DB_MISSING).toBe(3)
    expect(EXIT_WORKSPACE_UNRESOLVABLE).toBe(4)
  })

  test("DB_MISSING_MESSAGE points users at the index tool", () => {
    expect(DB_MISSING_MESSAGE).toContain("opentrace_repo_index")
  })
})

describe("workspaceUnresolvableMessage", () => {
  test("includes the directory verbatim so the LLM can echo it back", () => {
    const msg = workspaceUnresolvableMessage("/tmp/bogus/path")
    expect(msg).toContain("/tmp/bogus/path")
  })

  test("preserves spaces and special characters in paths", () => {
    const tricky = "/Users/me/My Code/proj (work)"
    expect(workspaceUnresolvableMessage(tricky)).toContain(tricky)
  })
})
