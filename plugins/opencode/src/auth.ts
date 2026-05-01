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

const GITHUB_USER_URL = "https://api.github.com/user"
const GITLAB_USER_URL = "https://gitlab.com/api/v4/user"

const FETCH_TIMEOUT_MS = 30_000
const VALIDATE_TIMEOUT_MS = 10_000

// Captured from OpenCode's loader; the SDK has no `auth.get`, so this is the only way to read our stored credential later.
let storedAuthGetter: (() => Promise<unknown>) | null = null

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

interface ProviderSpec {
  label: string
  userUrl: string
  patPlaceholder: string
}

const GITHUB: ProviderSpec = {
  label: "GitHub",
  userUrl: GITHUB_USER_URL,
  patPlaceholder: "ghp_xxxxxxxxxxxxxxxxxxxx",
}

const GITLAB: ProviderSpec = {
  label: "GitLab",
  userUrl: GITLAB_USER_URL,
  patPlaceholder: "glpat-xxxxxxxxxxxxxxxxxxxx",
}

// OpenCode's prompt API has only a `"text"` input type — the PAT is visible onscreen as the user types it.
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
      patMethod(GITHUB),
      patMethod(GITLAB),
    ],
  }
}

// Single-slot storage: GitHub and GitLab PATs share one provider-keyed credential, so multi-host setups must use env vars (GITHUB_TOKEN / GITLAB_TOKEN / OPENTRACE_GIT_TOKEN).
export async function getStoredToken(hostname: string | null): Promise<string | null> {
  // Skip unknown hosts — we can't tell which provider the stored token belongs to, so it could leak across hosts.
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

  // Strict suffix match — substring would leak to lookalikes like `attacker-gitlab.com`.
  if (hostname) {
    if (hostname === "github.com" || hostname.endsWith(".github.com")) {
      if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
    }
    if (hostname === "gitlab.com" || hostname.endsWith(".gitlab.com")) {
      if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN
    }
  }

  return process.env.OPENTRACE_GIT_TOKEN ?? null
}

function isKnownGitHost(hostname: string): boolean {
  return (
    hostname === "github.com" ||
    hostname.endsWith(".github.com") ||
    hostname === "gitlab.com" ||
    hostname.endsWith(".gitlab.com")
  )
}
