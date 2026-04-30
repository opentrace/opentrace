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

  test("declares both an oauth and an api method for github and gitlab", () => {
    const hook = createAuthHook()
    expect(hook.methods.length).toBe(4)
    const labels = hook.methods.map((m) => m.label)
    expect(labels).toEqual([
      "Sign in with GitHub",
      "Sign in with GitLab",
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

describe("OAuth device flow", () => {
  let origFetch: typeof globalThis.fetch
  let origSetTimeout: typeof globalThis.setTimeout
  let origClearTimeout: typeof globalThis.clearTimeout
  let fetchCalls: Array<{ url: string; init: RequestInit }> = []

  function installFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input)
      fetchCalls.push({ url, init: init as RequestInit })
      return handler(url, init as RequestInit)
    }) as typeof globalThis.fetch
  }

  const DEVICE = {
    device_code: "DEV_CODE_XXX",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 600,
    interval: 0,
  }

  function getMethod(label: string) {
    const hook = createAuthHook()
    return hook.methods.find((m) => m.label === label) as any
  }

  beforeEach(() => {
    origFetch = globalThis.fetch
    origSetTimeout = globalThis.setTimeout
    origClearTimeout = globalThis.clearTimeout
    fetchCalls = []
    // Fast-forward setTimeout so the polling loop runs in microtasks.
    ;(globalThis as any).setTimeout = (fn: () => void) => {
      queueMicrotask(fn)
      return 0
    }
    ;(globalThis as any).clearTimeout = () => {}
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    ;(globalThis as any).setTimeout = origSetTimeout
    ;(globalThis as any).clearTimeout = origClearTimeout
  })

  test("authorize() POSTs to the device-code endpoint with client_id + scopes and returns a verification URL + code", async () => {
    installFetch(async (url) => {
      if (url.includes("/login/device/code")) {
        return new Response(JSON.stringify(DEVICE), { status: 200 })
      }
      return new Response("{}", { status: 200 })
    })
    const session = await getMethod("Sign in with GitHub").authorize()
    expect(session.url).toBe("https://github.com/login/device")
    expect(session.instructions).toContain("ABCD-1234")
    expect(fetchCalls[0].url).toContain("github.com/login/device/code")
    expect(fetchCalls[0].init.method).toBe("POST")
    const body = String(fetchCalls[0].init.body)
    expect(body).toContain("client_id=")
    expect(body).toContain("scope=repo")
  })

  test("callback() returns success when the token endpoint immediately yields an access_token", async () => {
    installFetch(async (url) => {
      if (url.includes("/login/device/code")) return new Response(JSON.stringify(DEVICE), { status: 200 })
      return new Response(JSON.stringify({ access_token: "ghp_oauth" }), { status: 200 })
    })
    const session = await getMethod("Sign in with GitHub").authorize()
    const result = await session.callback()
    expect(result.type).toBe("success")
    expect(result.key).toBe("ghp_oauth")
    expect(result.provider).toBe("opentrace-git")
    const tokenPost = fetchCalls.find((c) => c.url.includes("/login/oauth/access_token"))!
    const body = String(tokenPost.init.body)
    expect(body).toContain("device_code=DEV_CODE_XXX")
    expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code")
  })

  test("callback() polls past authorization_pending until the token arrives", async () => {
    let polls = 0
    installFetch(async (url) => {
      if (url.includes("/login/device/code")) return new Response(JSON.stringify(DEVICE), { status: 200 })
      polls++
      if (polls < 3) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 })
      }
      return new Response(JSON.stringify({ access_token: "ghp_eventual" }), { status: 200 })
    })
    const session = await getMethod("Sign in with GitHub").authorize()
    const result = await session.callback()
    expect(result.type).toBe("success")
    expect(result.key).toBe("ghp_eventual")
    expect(polls).toBe(3)
  })

  test("callback() honors slow_down by continuing to poll", async () => {
    let polls = 0
    installFetch(async (url) => {
      if (url.includes("/login/device/code")) return new Response(JSON.stringify(DEVICE), { status: 200 })
      polls++
      if (polls === 1) return new Response(JSON.stringify({ error: "slow_down" }), { status: 200 })
      return new Response(JSON.stringify({ access_token: "ghp_after_slowdown" }), { status: 200 })
    })
    const session = await getMethod("Sign in with GitHub").authorize()
    const result = await session.callback()
    expect(result.type).toBe("success")
    expect(polls).toBe(2)
  })

  test("callback() returns 'failed' when the user denies authorization", async () => {
    installFetch(async (url) => {
      if (url.includes("/login/device/code")) return new Response(JSON.stringify(DEVICE), { status: 200 })
      return new Response(JSON.stringify({ error: "access_denied" }), { status: 200 })
    })
    const session = await getMethod("Sign in with GitHub").authorize()
    const result = await session.callback()
    expect(result.type).toBe("failed")
  })

  test("callback() returns 'failed' when the device code expires server-side", async () => {
    installFetch(async (url) => {
      if (url.includes("/login/device/code")) return new Response(JSON.stringify(DEVICE), { status: 200 })
      return new Response(JSON.stringify({ error: "expired_token" }), { status: 200 })
    })
    const session = await getMethod("Sign in with GitHub").authorize()
    const result = await session.callback()
    expect(result.type).toBe("failed")
  })

  test("callback() returns 'failed' on an unrecognized OAuth error code", async () => {
    installFetch(async (url) => {
      if (url.includes("/login/device/code")) return new Response(JSON.stringify(DEVICE), { status: 200 })
      return new Response(
        JSON.stringify({ error: "weird_provider_error", error_description: "?" }),
        { status: 200 },
      )
    })
    const session = await getMethod("Sign in with GitHub").authorize()
    const result = await session.callback()
    expect(result.type).toBe("failed")
  })

  test("callback() returns 'failed' when the polling deadline passes before authorization", async () => {
    // expires_in: 0 → deadline = now, so pollForToken bails before any token POST.
    installFetch(async (url) => {
      if (url.includes("/login/device/code")) {
        return new Response(JSON.stringify({ ...DEVICE, expires_in: 0 }), { status: 200 })
      }
      return new Response("unexpected", { status: 500 })
    })
    const session = await getMethod("Sign in with GitHub").authorize()
    const result = await session.callback()
    expect(result.type).toBe("failed")
    expect(fetchCalls.some((c) => c.url.includes("/login/oauth/access_token"))).toBe(false)
  })

  test("authorize() throws (rather than returning failed) when the device-code request itself fails", async () => {
    installFetch(async () => new Response("nope", { status: 500, statusText: "Internal Server Error" }))
    await expect(getMethod("Sign in with GitHub").authorize()).rejects.toThrow(
      /Device code request failed/,
    )
  })

  test("GitLab OAuth method routes to gitlab.com endpoints (not GitHub's)", async () => {
    installFetch(async (url) => {
      if (url.includes("/oauth/authorize_device")) {
        return new Response(JSON.stringify(DEVICE), { status: 200 })
      }
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "glat_xxx" }), { status: 200 })
      }
      return new Response("unexpected", { status: 500 })
    })
    const session = await getMethod("Sign in with GitLab").authorize()
    const result = await session.callback()
    expect(result.type).toBe("success")
    expect(result.key).toBe("glat_xxx")
    expect(fetchCalls[0].url).toContain("gitlab.com/oauth/authorize_device")
    expect(fetchCalls[1].url).toContain("gitlab.com/oauth/token")
    expect(String(fetchCalls[0].init.body)).toContain("scope=read_repository")
  })
})
