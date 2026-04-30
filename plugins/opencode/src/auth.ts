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

import type { AuthHook } from "@opencode-ai/plugin"
import { debug } from "./util/debug.js"

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

const GITHUB_CLIENT_ID = "Ov23lio0soXmsNwFv19s"
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code"
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
const GITHUB_USER_URL = "https://api.github.com/user"
const GITHUB_SCOPES = "repo read:org"

const GITLAB_CLIENT_ID = "67852cc9e0b910ea70152d349e991d202b192d43a8e3aced8b280a32671a1d0b"
const GITLAB_DEVICE_CODE_URL = "https://gitlab.com/oauth/authorize_device"
const GITLAB_TOKEN_URL = "https://gitlab.com/oauth/token"
const GITLAB_USER_URL = "https://gitlab.com/api/v4/user"
const GITLAB_SCOPES = "read_repository read_api"

// Timeouts
const FETCH_TIMEOUT_MS = 30_000
const VALIDATE_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Stored-token reader — captured via the AuthHook loader
// ---------------------------------------------------------------------------

/**
 * The getter OpenCode passes to our `loader` callback. Captured on first
 * loader invocation and used from `getStoredToken` at repo-index time.
 * When OpenCode never invokes the loader (e.g. the user has never logged
 * in), this stays null and we fall through to env vars.
 */
let storedAuthGetter: (() => Promise<unknown>) | null = null

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Fetch wrapper with an AbortController timeout. All network calls in this
 * file go through it so a GitHub/GitLab endpoint hanging can't stall the
 * plugin indefinitely.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = FETCH_TIMEOUT_MS, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Verify a pasted PAT actually works before we hand it back as a success.
 * The user sees an instant "that token is bogus" instead of discovering it
 * the first time `repo_index` tries to clone.
 */
async function validatePat(token: string, userUrl: string): Promise<void> {
  const resp = await fetchWithTimeout(userUrl, {
    timeoutMs: VALIDATE_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "opencode-opentrace",
    },
  })
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Token rejected by provider (${resp.status}). Check the token value and required scopes.`)
  }
  if (!resp.ok) {
    throw new Error(`Token validation failed (${resp.status} ${resp.statusText}).`)
  }
}

// ---------------------------------------------------------------------------
// Device-flow primitives (generic, parameterized by host)
// ---------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

/**
 * Shared OAuth error mapping — provider-agnostic. GitHub and GitLab use
 * the same RFC 8628 error codes, so one translator fits both.
 */
function deviceFlowError(code: string, description?: string): Error {
  switch (code) {
    case "expired_token":
      return new Error("Device code expired before authorization completed. Please try again.")
    case "access_denied":
      return new Error("Authorization was denied.")
    case "authorization_pending":
    case "slow_down":
      // Caller handles these via the polling loop — not real errors.
      return new Error(code)
    default:
      return new Error(`OAuth error: ${code}${description ? ` — ${description}` : ""}`)
  }
}

async function requestDeviceCode(
  endpoint: string,
  clientId: string,
  scope: string,
): Promise<DeviceCodeResponse> {
  const resp = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  })
  if (!resp.ok) {
    throw new Error(`Device code request failed: ${resp.status} ${resp.statusText}`)
  }
  return resp.json() as Promise<DeviceCodeResponse>
}

async function pollForToken(
  endpoint: string,
  clientId: string,
  deviceCode: string,
  initialInterval: number,
  expiresIn: number,
): Promise<{ access_token: string }> {
  const deadline = Date.now() + expiresIn * 1000
  let pollInterval = Math.max(initialInterval, 1) * 1000

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval))

    const resp = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    })
    const data = (await resp.json()) as { access_token?: string; error?: string; error_description?: string }

    if (data.access_token) return { access_token: data.access_token }

    if (data.error === "slow_down") {
      pollInterval += 5000
      continue
    }
    if (data.error === "authorization_pending") {
      continue
    }
    if (data.error) {
      throw deviceFlowError(data.error, data.error_description)
    }
  }

  throw new Error("Timed out waiting for authorization.")
}

// ---------------------------------------------------------------------------
// AuthHook
// ---------------------------------------------------------------------------

interface ProviderSpec {
  label: string
  deviceUrl: string
  tokenUrl: string
  userUrl: string
  clientId: string
  scopes: string
  patPlaceholder: string
}

const GITHUB: ProviderSpec = {
  label: "GitHub",
  deviceUrl: GITHUB_DEVICE_CODE_URL,
  tokenUrl: GITHUB_TOKEN_URL,
  userUrl: GITHUB_USER_URL,
  clientId: GITHUB_CLIENT_ID,
  scopes: GITHUB_SCOPES,
  patPlaceholder: "ghp_xxxxxxxxxxxxxxxxxxxx",
}

const GITLAB: ProviderSpec = {
  label: "GitLab",
  deviceUrl: GITLAB_DEVICE_CODE_URL,
  tokenUrl: GITLAB_TOKEN_URL,
  userUrl: GITLAB_USER_URL,
  clientId: GITLAB_CLIENT_ID,
  scopes: GITLAB_SCOPES,
  patPlaceholder: "glpat-xxxxxxxxxxxxxxxxxxxx",
}

/**
 * Build an OAuth device-flow method for *spec*. GitHub and GitLab share
 * the shape; only URLs/scopes differ.
 */
function oauthMethod(spec: ProviderSpec) {
  return {
    type: "oauth" as const,
    label: `Sign in with ${spec.label}`,
    async authorize() {
      const device = await requestDeviceCode(spec.deviceUrl, spec.clientId, spec.scopes)
      const url = device.verification_uri_complete ?? device.verification_uri
      const instructions = `Enter code: ${device.user_code}`

      return {
        url,
        instructions,
        method: "auto" as const,
        async callback() {
          try {
            const tokens = await pollForToken(
              spec.tokenUrl,
              spec.clientId,
              device.device_code,
              device.interval,
              device.expires_in,
            )
            return {
              type: "success" as const,
              key: tokens.access_token,
              provider: "opentrace-git",
            }
          } catch (e) {
            // OpenCode's AuthHook surface only lets us return "failed" to
            // the UI, so log the specific reason for users running with
            // `debug: true`.
            debug("auth", `${spec.label} OAuth callback failed:`, (e as Error).message)
            return { type: "failed" as const }
          }
        },
      }
    },
  }
}

/**
 * Build a PAT input method for *spec*. Validates the pasted token against
 * the provider's /user endpoint before returning success.
 *
 * Note: OpenCode's AuthHook prompts only support a `"text"` input type —
 * there is no "password" / "secret" variant that would mask the value
 * during entry. The PAT is visible in the prompt as the user types.
 */
function patMethod(spec: ProviderSpec) {
  return {
    type: "api" as const,
    label: `${spec.label} Personal Access Token`,
    prompts: [
      {
        type: "text" as const,
        key: "token",
        message: `Enter your ${spec.label} Personal Access Token`,
        placeholder: spec.patPlaceholder,
        validate: (value: string) => {
          if (!value.trim()) return "Token is required"
          return undefined
        },
      },
    ],
    async authorize(inputs?: Record<string, string>) {
      const token = inputs?.token?.trim()
      if (!token) return { type: "failed" as const }
      try {
        await validatePat(token, spec.userUrl)
      } catch (e) {
        debug("auth", `${spec.label} PAT validation failed:`, (e as Error).message)
        return { type: "failed" as const }
      }
      return {
        type: "success" as const,
        key: token,
        provider: "opentrace-git",
      }
    },
  }
}

export function createAuthHook(): AuthHook {
  return {
    provider: "opentrace-git",
    // Capture the getter so `getStoredToken` can read the stored credential
    // at repo-index time. The loader's return value is unused for git
    // (OpenCode routes it to LLM-provider resolution, which doesn't apply
    // to us), but capturing the getter here is the only way a plugin can
    // read its own stored auth — the SDK has `auth.set`/`auth.remove`
    // but no `auth.get`.
    loader: async (auth, _provider) => {
      storedAuthGetter = auth
      try {
        const stored = await auth()
        return (stored ?? {}) as Record<string, any>
      } catch {
        return {}
      }
    },
    methods: [
      oauthMethod(GITHUB),
      oauthMethod(GITLAB),
      patMethod(GITHUB),
      patMethod(GITLAB),
    ],
  }
}

/**
 * Return the currently stored git token, or null if the user hasn't
 * logged in and no env-var fallback is set.
 *
 * Storage model: a single token at a time. OpenCode's AuthHook API
 * stores one credential per `provider` string; we use `opentrace-git`
 * for all four methods, so a GitHub login replaces a prior GitLab
 * login and vice versa. Callers needing multi-host support should
 * set the matching env var (GITHUB_TOKEN / GITLAB_TOKEN) or the
 * neutral OPENTRACE_GIT_TOKEN override.
 *
 * Why single-slot and not host-tagged: OpenCode's method callback
 * return shape doesn't let us write to the ApiAuth `metadata` field
 * at store time, and the SDK has no auth-get API for us to inspect
 * the stored Auth's provider tag independently. The plugin therefore
 * can't reliably tell which host a stored token belongs to —
 * returning it unconditionally would risk sending a GitHub PAT to
 * GitLab. For the common single-host case, the keychain is enough;
 * for multi-host, env vars are explicit and safe.
 */
export async function getStoredToken(hostname: string | null): Promise<string | null> {
  // 1. OpenCode keychain — only safe to return when we can match the
  //    hostname to a specific env-var pair below. If the user has
  //    logged in via OpenCode and set neither GITHUB_TOKEN nor
  //    GITLAB_TOKEN nor OPENTRACE_GIT_TOKEN, we fall back to the
  //    stored key for common hosts (github.com / gitlab.com). For any
  //    unrecognized host we skip the keychain to avoid cross-host leak.
  if (storedAuthGetter && hostname && isKnownGitHost(hostname)) {
    try {
      const stored = (await storedAuthGetter()) as { key?: unknown; access?: unknown } | null | undefined
      if (stored) {
        if (typeof stored.key === "string" && stored.key) return stored.key
        if (typeof stored.access === "string" && stored.access) return stored.access
      }
    } catch (e) {
      debug("auth", "getStoredToken: loader getter threw", e)
    }
  }

  // 2. Host-specific env var.
  if (hostname) {
    if (hostname === "github.com" || hostname.endsWith(".github.com")) {
      if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
    }
    if (hostname === "gitlab.com" || hostname.endsWith(".gitlab.com") || hostname.includes("gitlab")) {
      if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN
    }
  }

  // 3. Explicit cross-host override.
  return process.env.OPENTRACE_GIT_TOKEN ?? null
}

/**
 * Whether *hostname* is one the plugin's OAuth methods know how to
 * authenticate against. Used to gate the keychain-read path: for
 * hosts we don't recognize (self-hosted GitHub Enterprise, Gitea,
 * custom GitLab domains) the keychain match is ambiguous, so skip
 * it and rely on env vars.
 */
function isKnownGitHost(hostname: string): boolean {
  return (
    hostname === "github.com" ||
    hostname.endsWith(".github.com") ||
    hostname === "gitlab.com" ||
    hostname.endsWith(".gitlab.com")
  )
}
