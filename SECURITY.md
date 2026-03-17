# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OpenTrace, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@opentrace.ai** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

## Scope

OpenTrace runs entirely in the browser. The primary attack surface is:

- **GitHub/GitLab API tokens** — stored in browser localStorage, used to fetch repository contents
- **KuzuDB WASM** — embedded database running in-browser
- **tree-sitter WASM parsers** — parse untrusted source code in a Web Worker

## Supported Versions

We provide security fixes for the latest release only.
