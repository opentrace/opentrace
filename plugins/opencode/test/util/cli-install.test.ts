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
import { getCliMissingMessage } from "../../src/util/cli-install.js"

describe("getCliMissingMessage", () => {
  const msg = getCliMissingMessage()

  test("explains the CLI is unavailable", () => {
    expect(msg).toContain("opentraceai")
    expect(msg.toLowerCase()).toContain("install")
  })

  test("recommends both supported install paths", () => {
    expect(msg).toContain("uv tool install")
    expect(msg).toContain("pipx install")
  })

  test("mentions install can complete without a restart", () => {
    expect(msg.toLowerCase()).toContain("no")
    expect(msg.toLowerCase()).toContain("restart")
  })

  test("instructs the LLM to ask before running an install", () => {
    expect(msg.toLowerCase()).toContain("ask the user")
  })
})
