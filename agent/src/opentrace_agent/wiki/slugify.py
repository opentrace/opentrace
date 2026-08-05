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

"""Title → filesystem-safe slug.

The one caller left is vault *naming* — deriving a validated vault name from
a repo name, folder name, or uploaded filename (see ``cli/main.py`` and
``cli/vault_cmd.py``). The page-slug machinery this module was written for
(``kind_dir`` / ``unique_slug`` / ``title_to_link_slug``, the
``<kind_dir>/<base>`` path shape, and tombstone reservation for stale
``[[wiki-links]]``) went with the concept-page layer on 2026-08-04.
"""

from __future__ import annotations

import re
import unicodedata

MAX_SLUG_LEN = 80
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def base_slug(title: str) -> str:
    """Return the slug for *title*.

    Lowercased, ASCII-folded, non-alphanumeric runs collapsed to a single dash,
    truncated to MAX_SLUG_LEN. Empty input yields ``"untitled"``.
    """
    if not title:
        return "untitled"
    folded = unicodedata.normalize("NFKD", title)
    folded = folded.encode("ascii", "ignore").decode("ascii")
    folded = folded.lower()
    folded = _NON_ALNUM.sub("-", folded).strip("-")
    if not folded:
        return "untitled"
    return folded[:MAX_SLUG_LEN].rstrip("-") or "untitled"
