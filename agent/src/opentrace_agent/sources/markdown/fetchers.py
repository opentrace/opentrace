# Copyright 2026 OpenTrace Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""URL fetching that hands clean inputs to the doc-normalize stage.

Most URLs go straight through ``markitdown.convert_url`` — markitdown handles
HTML, YouTube transcripts, and PDFs over the wire. The exceptions are:

* **arXiv abstract pages** (``arxiv.org/abs/...``) — the abstract page is a
  JS-heavy HTML wrapper. The actual document is the PDF at the
  ``/pdf/<id>.pdf`` URL, which markitdown can convert cleanly.

Tweets are explicitly not supported in v1 (X/Twitter aggressively blocks
scraping). The :func:`resolve` function raises ``UnsupportedSourceError``
for those — callers should treat that as a user error.
"""

from __future__ import annotations

import re
import urllib.request
from urllib.parse import urlparse


class UnsupportedSourceError(ValueError):
    """Raised when a URL points at a source we explicitly don't support yet."""


_ARXIV_ABS = re.compile(r"^/abs/(\d{4}\.\d{4,5}(v\d+)?)/?$")


def resolve(path_or_url: str) -> str:
    """Return a URL or path that markitdown can convert directly.

    For most inputs this is the identity function. For arXiv abstract pages
    it rewrites to the PDF URL. For known-unsupported sources (X/Twitter)
    it raises ``UnsupportedSourceError``.
    """
    parsed = urlparse(path_or_url)
    if parsed.scheme not in ("http", "https"):
        return path_or_url  # local file or non-URL — caller handles it

    host = (parsed.netloc or "").lower()

    # Tweets/X: bounce out with an actionable error.
    if host in ("twitter.com", "x.com", "www.twitter.com", "www.x.com", "mobile.twitter.com"):
        raise UnsupportedSourceError(f"X/Twitter is not supported (anti-scrape). URL: {path_or_url}")

    # arXiv abstract → PDF rewrite.
    if host.endswith("arxiv.org"):
        match = _ARXIV_ABS.match(parsed.path or "")
        if match:
            arxiv_id = match.group(1)
            return f"https://arxiv.org/pdf/{arxiv_id}.pdf"

    return path_or_url


def is_url(s: str) -> bool:
    """True when *s* starts with an http(s):// scheme."""
    scheme = urlparse(s).scheme
    return scheme in ("http", "https")


def fetch_bytes(url: str, *, timeout: float = 30.0) -> bytes:
    """Download *url* and return its raw bytes.

    Used to compute a content-addressed sha for URL inputs before handing the
    URL itself to markitdown. Yes, this means two requests for the same URL —
    one for hashing, one for conversion. They typically hit the same CDN
    cache, and the alternative (hashing the markdown output) loses identity
    when markitdown's parser changes.
    """
    req = urllib.request.Request(url, headers={"User-Agent": "opentraceai/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def url_basename(url: str) -> str:
    """Return a filesystem-safe basename for a URL.

    Prefers the last non-empty path segment; falls back to the host name.
    Used as the ``name`` field on the SourceInput so the resulting Source
    node has a recognisable title.
    """
    parsed = urlparse(url)
    parts = [p for p in (parsed.path or "").split("/") if p]
    if parts:
        return parts[-1]
    return (parsed.netloc or "url").replace(":", "_")
