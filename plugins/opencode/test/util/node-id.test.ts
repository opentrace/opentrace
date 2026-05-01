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
  filePathFromNodeId,
  parseNodeId,
  repoFromNodeId,
} from "../../src/util/node-id.js"

describe("parseNodeId", () => {
  test("repo-only id → only repo populated", () => {
    expect(parseNodeId("acme")).toEqual({ repo: "acme", path: null, symbol: null })
  })

  test("repo + file id → repo + path", () => {
    expect(parseNodeId("acme/src/router.ts")).toEqual({
      repo: "acme",
      path: "src/router.ts",
      symbol: null,
    })
  })

  test("repo + file + symbol id → all three", () => {
    expect(parseNodeId("acme/src/router.ts::Router")).toEqual({
      repo: "acme",
      path: "src/router.ts",
      symbol: "Router",
    })
  })

  test("symbol on repo-only id (no slash) keeps repo as the path-prefix", () => {
    expect(parseNodeId("acme::Router")).toEqual({
      repo: "acme",
      path: null,
      symbol: "Router",
    })
  })

  test("symbol containing :: is preserved verbatim after first split", () => {
    expect(parseNodeId("acme/src/foo.cpp::ns::Klass")).toEqual({
      repo: "acme",
      path: "src/foo.cpp",
      symbol: "ns::Klass",
    })
  })

  test("nested file path keeps everything after the first slash", () => {
    expect(parseNodeId("acme/a/b/c/d.ts")).toEqual({
      repo: "acme",
      path: "a/b/c/d.ts",
      symbol: null,
    })
  })

  test("empty string yields empty repo and nulls", () => {
    expect(parseNodeId("")).toEqual({ repo: "", path: null, symbol: null })
  })

  test("trailing :: yields empty symbol string (not null)", () => {
    expect(parseNodeId("acme/foo.ts::")).toEqual({
      repo: "acme",
      path: "foo.ts",
      symbol: "",
    })
  })
})

describe("repoFromNodeId / filePathFromNodeId", () => {
  test("repoFromNodeId returns just the repo segment", () => {
    expect(repoFromNodeId("acme/src/foo.ts::Bar")).toBe("acme")
    expect(repoFromNodeId("acme")).toBe("acme")
    expect(repoFromNodeId("acme::Bar")).toBe("acme")
  })

  test("filePathFromNodeId strips symbol suffix", () => {
    expect(filePathFromNodeId("acme/src/router.ts::Router")).toBe("src/router.ts")
    expect(filePathFromNodeId("acme/src/router.ts")).toBe("src/router.ts")
  })

  test("filePathFromNodeId returns null when no file segment", () => {
    expect(filePathFromNodeId("acme")).toBeNull()
    expect(filePathFromNodeId("acme::Bar")).toBeNull()
  })
})
