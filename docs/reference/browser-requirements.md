# Browser Requirements

OpenTrace runs entirely in the browser using WebAssembly. This requires **Cross-Origin Isolation**, a browser security feature that enables `SharedArrayBuffer` — needed by the embedded LadybugDB graph database.

## What is Cross-Origin Isolation?

After the [Spectre](https://en.wikipedia.org/wiki/Spectre_(security_vulnerability)) vulnerability, browsers restricted access to `SharedArrayBuffer` and high-resolution timers. To re-enable them, a page must opt in by serving two HTTP headers:

| Header | Value | Purpose |
|--------|-------|---------|
| `Cross-Origin-Opener-Policy` | `same-origin` | Isolates the browsing context group |
| `Cross-Origin-Embedder-Policy` | `credentialless` | Controls cross-origin resource loading |

When both headers are present, the browser sets `window.crossOriginIsolated = true` and unlocks `SharedArrayBuffer`.

## Supported Browsers

Any modern browser supports cross-origin isolation:

| Browser | Minimum Version |
|---------|----------------|
| Chrome / Edge | 91+ |
| Firefox | 119+ (for `credentialless`) |
| Safari | 15.2+ |

## Unsupported Environments

The following environments do **not** support cross-origin isolation and cannot run OpenTrace:

- **Link preview renderers** — Apple Mail, Slack, Discord, and other apps that preview links use minimal embedded browsers without full header support.
- **Older browsers** — Safari < 15.2, Firefox < 119, or any browser that doesn't support `SharedArrayBuffer`.
- **Iframes on non-isolated pages** — if OpenTrace is embedded in an iframe, the parent page must also be cross-origin isolated.
- **Proxies that strip headers** — some corporate proxies or browser extensions remove COOP/COEP headers.

## Self-Hosting

If you are hosting OpenTrace yourself, ensure your web server sends both headers on all responses. For example:

### Nginx

```nginx
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "credentialless" always;
```

### Caddy

```caddy
header {
    Cross-Origin-Opener-Policy "same-origin"
    Cross-Origin-Embedder-Policy "credentialless"
}
```

### Cloudflare Pages

Create a `_headers` file in your build output:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
```

### Vite Dev Server

The dev server sets these headers automatically — no configuration needed.
