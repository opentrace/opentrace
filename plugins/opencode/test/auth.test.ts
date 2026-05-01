/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createAuthHook, getStoredToken } from "../src/auth.js"

describe("getStoredToken — env var resolution", () => {
  const ENV_KEYS = ["GITHUB_TOKEN", "GITLAB_TOKEN", "OPENTRACE_GIT_TOKEN"] as const
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      original[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = original[k]
      }
    }
  })

  test("returns null when no env var is set and no auth has been loaded", async () => {
    expect(await getStoredToken("github.com")).toBeNull()
  })

  test("github.com hostname → GITHUB_TOKEN", async () => {
    process.env.GITHUB_TOKEN = "ghp_aaa"
    expect(await getStoredToken("github.com")).toBe("ghp_aaa")
  })

  test("subdomain of github.com (api.github.com) also matches GITHUB_TOKEN", async () => {
    process.env.GITHUB_TOKEN = "ghp_aaa"
    expect(await getStoredToken("api.github.com")).toBe("ghp_aaa")
  })

  test("gitlab.com hostname → GITLAB_TOKEN", async () => {
    process.env.GITLAB_TOKEN = "glpat_bbb"
    expect(await getStoredToken("gitlab.com")).toBe("glpat_bbb")
  })

  test("subdomain of gitlab.com matches GITLAB_TOKEN", async () => {
    process.env.GITLAB_TOKEN = "glpat_bbb"
    expect(await getStoredToken("foo.gitlab.com")).toBe("glpat_bbb")
  })

  test("lookalike hostname does NOT match host-specific env var", async () => {
    process.env.GITLAB_TOKEN = "glpat_bbb"
    expect(await getStoredToken("attacker-gitlab.com")).toBeNull()
    expect(await getStoredToken("gitlab.com.attacker.io")).toBeNull()
    process.env.GITHUB_TOKEN = "ghp_aaa"
    expect(await getStoredToken("github.com.evil.io")).toBeNull()
  })

  test("OPENTRACE_GIT_TOKEN is the cross-host fallback", async () => {
    process.env.OPENTRACE_GIT_TOKEN = "neutral_xxx"
    expect(await getStoredToken("self-hosted-gitea.example.com")).toBe("neutral_xxx")
    expect(await getStoredToken("github.com")).toBe("neutral_xxx")
  })

  test("host-specific env var is preferred over OPENTRACE_GIT_TOKEN", async () => {
    process.env.GITHUB_TOKEN = "ghp_specific"
    process.env.OPENTRACE_GIT_TOKEN = "neutral"
    expect(await getStoredToken("github.com")).toBe("ghp_specific")
  })

  test("null hostname (local path indexing) skips host gating, falls through to neutral env var", async () => {
    process.env.GITHUB_TOKEN = "ghp_x"
    process.env.OPENTRACE_GIT_TOKEN = "neutral"
    expect(await getStoredToken(null)).toBe("neutral")
  })

  test("null hostname with no neutral fallback returns null", async () => {
    process.env.GITHUB_TOKEN = "ghp_x"
    expect(await getStoredToken(null)).toBeNull()
  })
})

describe("createAuthHook", () => {
  test("registers under the opentrace-git provider", () => {
    const hook = createAuthHook()
    expect(hook.provider).toBe("opentrace-git")
  })

  test("declares a PAT method for github and gitlab", () => {
    const hook = createAuthHook()
    expect(hook.methods.length).toBe(2)
    const labels = hook.methods.map((m) => m.label)
    expect(labels).toEqual([
      "GitHub Personal Access Token",
      "GitLab Personal Access Token",
    ])
  })

  test("PAT method validates the input is non-empty", () => {
    const hook = createAuthHook()
    const pat = hook.methods.find((m) => m.label === "GitHub Personal Access Token")!
    expect(pat.type).toBe("api")
    const prompt = pat.prompts?.[0]
    expect(prompt?.type).toBe("text")
    const validate = prompt?.type === "text" ? prompt.validate : undefined
    expect(validate).toBeTypeOf("function")
    expect(validate!("")).toBe("Token is required")
    expect(validate!("   ")).toBe("Token is required")
    expect(validate!("ghp_real_looking")).toBeUndefined()
  })

  test("PAT authorize without input returns 'failed' rather than throwing", async () => {
    const hook = createAuthHook()
    const pat = hook.methods.find((m) => m.label === "GitHub Personal Access Token") as any
    const result = await pat.authorize({})
    expect(result.type).toBe("failed")
  })

  test("loader captures the auth getter and returns the loaded record", async () => {
    const hook = createAuthHook()
    const stored = { key: "stored-token-value" }
    const result = await hook.loader!(async () => stored as any, undefined as any)
    expect(result).toEqual(stored)
  })

  test("loader returns empty object if the getter throws", async () => {
    const hook = createAuthHook()
    const result = await hook.loader!(async () => {
      throw new Error("denied")
    }, undefined as any)
    expect(result).toEqual({})
  })
})

describe("PAT method authorize — provider validation", () => {
  let origFetch: typeof globalThis.fetch
  let lastInit: { url: string; init: RequestInit } | null = null
  function installFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      lastInit = { url: String(input), init }
      return impl(String(input), init)
    }) as typeof globalThis.fetch
  }

  beforeEach(() => {
    origFetch = globalThis.fetch
    lastInit = null
  })

  afterEach(() => {
    globalThis.fetch = origFetch
  })

  test("200 OK from /user → success with the token as the credential key", async () => {
    installFetch(async () => new Response('{"login":"octocat"}', { status: 200 }))
    const hook = createAuthHook()
    const pat = hook.methods.find((m) => m.label === "GitHub Personal Access Token") as any
    const result = await pat.authorize({ token: "ghp_valid" })
    expect(result.type).toBe("success")
    expect(result.key).toBe("ghp_valid")
    expect(result.provider).toBe("opentrace-git")
    expect((lastInit!.init.headers as any).Authorization).toBe("Bearer ghp_valid")
    expect(lastInit!.url).toContain("api.github.com/user")
  })

  test("401 from /user → failed (provider rejected the token)", async () => {
    installFetch(async () => new Response("Bad credentials", { status: 401 }))
    const hook = createAuthHook()
    const pat = hook.methods.find((m) => m.label === "GitHub Personal Access Token") as any
    const result = await pat.authorize({ token: "ghp_revoked" })
    expect(result.type).toBe("failed")
  })

  test("403 from /user → failed (insufficient scopes treated the same as auth fail)", async () => {
    installFetch(async () => new Response("Forbidden", { status: 403 }))
    const hook = createAuthHook()
    const pat = hook.methods.find((m) => m.label === "GitHub Personal Access Token") as any
    const result = await pat.authorize({ token: "ghp_underscoped" })
    expect(result.type).toBe("failed")
  })

  test("non-OK status outside 401/403 → failed", async () => {
    installFetch(async () => new Response("Service unavailable", { status: 503, statusText: "Service Unavailable" }))
    const hook = createAuthHook()
    const pat = hook.methods.find((m) => m.label === "GitHub Personal Access Token") as any
    const result = await pat.authorize({ token: "ghp_anything" })
    expect(result.type).toBe("failed")
  })

  test("GitLab PAT method routes to gitlab.com/api/v4/user", async () => {
    installFetch(async () => new Response("{}", { status: 200 }))
    const hook = createAuthHook()
    const pat = hook.methods.find((m) => m.label === "GitLab Personal Access Token") as any
    await pat.authorize({ token: "glpat_xxx" })
    expect(lastInit!.url).toContain("gitlab.com/api/v4/user")
  })

  test("token whitespace is trimmed before validation", async () => {
    installFetch(async () => new Response("{}", { status: 200 }))
    const hook = createAuthHook()
    const pat = hook.methods.find((m) => m.label === "GitHub Personal Access Token") as any
    const result = await pat.authorize({ token: "  ghp_padded  " })
    expect(result.type).toBe("success")
    expect(result.key).toBe("ghp_padded")
    expect((lastInit!.init.headers as any).Authorization).toBe("Bearer ghp_padded")
  })
})

describe("getStoredToken — keychain branch via the loader getter", () => {
  const ENV_KEYS = ["GITHUB_TOKEN", "GITLAB_TOKEN", "OPENTRACE_GIT_TOKEN"] as const
  const original: Record<string, string | undefined> = {}

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      original[k] = process.env[k]
      delete process.env[k]
    }
    const hook = createAuthHook()
    await hook.loader!(async () => ({ key: "keychain_xxx" }) as any, undefined as any)
  })

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = original[k]
      }
    }
    const hook = createAuthHook()
    await hook.loader!(async () => null as any, undefined as any)
  })

  test("known host (github.com) reads the stored keychain token", async () => {
    expect(await getStoredToken("github.com")).toBe("keychain_xxx")
  })

  test("known host (gitlab.com) reads the stored keychain token", async () => {
    expect(await getStoredToken("gitlab.com")).toBe("keychain_xxx")
  })

  test("unknown host (self-hosted) does NOT receive the keychain token", async () => {
    expect(await getStoredToken("git.example.com")).toBeNull()
  })

  test("keychain wins over env var on a known host (priority 1 > 2)", async () => {
    process.env.GITHUB_TOKEN = "ghp_env"
    expect(await getStoredToken("github.com")).toBe("keychain_xxx")
  })

  test("stored.access is read as a fallback when stored.key is absent", async () => {
    const hook = createAuthHook()
    await hook.loader!(async () => ({ access: "via_access_field" }) as any, undefined as any)
    expect(await getStoredToken("github.com")).toBe("via_access_field")
  })

  test("stored.key takes precedence over stored.access when both are present", async () => {
    const hook = createAuthHook()
    await hook.loader!(
      async () => ({ key: "via_key", access: "via_access" }) as any,
      undefined as any,
    )
    expect(await getStoredToken("github.com")).toBe("via_key")
  })

  test("getter throwing falls through to env vars rather than propagating", async () => {
    const hook = createAuthHook()
    await hook.loader!(async () => {
      throw new Error("keychain locked")
    }, undefined as any)
    process.env.GITHUB_TOKEN = "ghp_env_fallback"
    expect(await getStoredToken("github.com")).toBe("ghp_env_fallback")
  })
})
