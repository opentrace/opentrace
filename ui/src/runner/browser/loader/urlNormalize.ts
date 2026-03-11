/**
 * Normalize Git remote URLs to HTTPS format.
 *
 * Converts SSH URLs (SCP-style and ssh:// protocol) to their HTTPS
 * equivalents so existing GitHub/GitLab URL parsers can handle them.
 */

/**
 * Convert any common Git remote URL to an HTTPS URL.
 *
 * Handles:
 *  - SCP-style:    git@host:owner/repo[.git]  → https://host/owner/repo
 *  - SSH protocol: ssh://git@host/owner/repo[.git] → https://host/owner/repo
 *  - HTTPS/other:  passed through unchanged (with .git suffix stripped)
 */
export function normalizeRepoUrl(raw: string): string {
  const trimmed = raw.trim();

  // SCP-style: git@github.com:owner/repo.git
  const scpMatch = trimmed.match(/^[\w.-]+@([^:]+):(.+)$/);
  if (scpMatch) {
    const host = scpMatch[1];
    const path = stripDotGit(scpMatch[2]);
    return `https://${host}/${path}`;
  }

  // SSH protocol: ssh://git@github.com/owner/repo.git
  const sshMatch = trimmed.match(/^ssh:\/\/[\w.-]+@([^/]+)\/(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = stripDotGit(sshMatch[2]);
    return `https://${host}/${path}`;
  }

  // Everything else: strip .git suffix if present, pass through
  return stripDotGit(trimmed);
}

function stripDotGit(s: string): string {
  return s.endsWith(".git") ? s.slice(0, -4) : s;
}
