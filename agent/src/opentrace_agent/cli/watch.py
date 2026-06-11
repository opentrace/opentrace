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

"""``opentraceai watch`` — re-index when files change.

A debounced filesystem watcher backed by ``watchdog``. Filesystem events
buffer for ``--debounce`` seconds, then a single rebuild fires.

Two seams:

* :func:`build_event_handler` returns a ``watchdog`` handler given a
  callback. Pure, testable without an actual filesystem watch.
* :class:`Debouncer` schedules a callback after a delay. Re-arming
  cancels the pending fire, so a burst of events triggers one rebuild.

The CLI wires them together to call the indexer; the parts are testable
in isolation.

SCAFFOLDING: the rebuild itself (:func:`_run_incremental_index`) is a
no-op shim — incremental indexing never landed after the integration.
Watching, filtering, and debouncing are real and tested; the command
detects changes and prints that it's rebuilding, but nothing is indexed
until the shim is wired to the incremental pipeline.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import click

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------


# Filesystem noise we don't want to trigger a re-index for.
DEFAULT_IGNORE_PREFIXES: tuple[str, ...] = (
    ".git/",
    ".opentrace/",
    "node_modules/",
    "__pycache__/",
    ".venv/",
    "dist/",
    "build/",
    ".pytest_cache/",
    ".ruff_cache/",
)


def should_ignore(rel_path: str, ignore_prefixes: Iterable[str] = DEFAULT_IGNORE_PREFIXES) -> bool:
    """True if ``rel_path`` falls inside an ignored directory.

    Match is on directory prefix, anchored at the start of the path. Hidden
    files (``.foo``) at the root are kept — only directory noise is suppressed.
    """
    normalised = rel_path.replace("\\", "/").lstrip("/")
    return any(normalised.startswith(p) or f"/{p}" in f"/{normalised}" for p in ignore_prefixes)


class Debouncer:
    """Fire a callback after a quiet period of length ``delay``.

    Re-arming with :meth:`schedule` while a fire is pending cancels and
    restarts the timer. Safe to call from multiple threads.
    """

    def __init__(self, delay: float, callback: Callable[[], None]) -> None:
        self._delay = delay
        self._callback = callback
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    def schedule(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self._delay, self._fire)
            self._timer.daemon = True
            self._timer.start()

    def _fire(self) -> None:
        with self._lock:
            self._timer = None
        try:
            self._callback()
        except Exception:  # noqa: BLE001
            logger.exception("Debounced callback raised")

    def cancel(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None


def build_event_handler(
    root: Path,
    on_change: Callable[[str], None],
    ignore_prefixes: Iterable[str] = DEFAULT_IGNORE_PREFIXES,
) -> Any:
    """Return a watchdog event handler that invokes ``on_change`` on real edits.

    The handler is constructed inside this function so the watchdog import is
    optional — callers without ``opentraceai[graph-watch]`` installed never
    touch it.
    """
    try:
        from watchdog.events import FileSystemEvent, FileSystemEventHandler  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("watchdog not installed. Run: uv pip install 'opentraceai[graph-watch]'") from exc

    root_resolved = root.resolve()
    ignore = tuple(ignore_prefixes)

    class _Handler(FileSystemEventHandler):
        def on_any_event(self, event: FileSystemEvent) -> None:  # noqa: N802
            if event.is_directory:
                return
            if event.event_type not in ("created", "modified", "deleted", "moved"):
                return
            path_str = str(event.src_path)
            try:
                rel = str(Path(path_str).resolve().relative_to(root_resolved))
            except ValueError:
                return  # outside the watched root
            if should_ignore(rel, ignore):
                return
            on_change(rel)

    return _Handler()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@click.command("watch")
@click.argument(
    "path",
    default=".",
    type=click.Path(exists=True, file_okay=False, resolve_path=True),
)
@click.option(
    "--debounce",
    default=2.0,
    show_default=True,
    type=float,
    help="Seconds of quiet before triggering a rebuild.",
)
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="OpenTrace database path (auto-detected if omitted).",
)
def watch(path: str, debounce: float, db_path: str | None) -> None:
    """Watch PATH for changes and re-run incremental indexing.

    Coalesces bursts of edits with a debounce window. Press Ctrl-C to stop.
    """
    try:
        from watchdog.observers import Observer  # type: ignore[import-not-found]
    except ImportError as exc:
        raise click.ClickException("watchdog not installed. Run: uv pip install 'opentraceai[graph-watch]'") from exc

    root = Path(path)
    click.echo(f"Watching {root} (debounce={debounce:.1f}s, Ctrl-C to stop)")

    pending: list[str] = []
    pending_lock = threading.Lock()

    def rebuild() -> None:
        with pending_lock:
            changed = list(pending)
            pending.clear()
        if not changed:
            return
        click.echo(f"[{time.strftime('%H:%M:%S')}] {len(changed)} file(s) changed, rebuilding…")
        try:
            _run_incremental_index(str(root), db_path)
        except Exception as exc:  # noqa: BLE001
            click.echo(f"  index failed: {exc}", err=True)

    debouncer = Debouncer(debounce, rebuild)

    def on_change(rel: str) -> None:
        with pending_lock:
            pending.append(rel)
        debouncer.schedule()

    handler = build_event_handler(root, on_change)
    observer = Observer()
    observer.schedule(handler, str(root), recursive=True)
    observer.start()
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        click.echo("\nStopping watcher.")
    finally:
        observer.stop()
        observer.join(timeout=5.0)
        debouncer.cancel()


def _run_incremental_index(root: str, db_path: str | None) -> None:
    """Hook for the indexer — kept tiny so tests can stub it.

    No-op shim until incremental indexing exists (see the SCAFFOLDING note
    in the module docstring). When an ``index --incremental`` equivalent
    lands, this is the single seam to wire it through — same seam the git
    post-commit hook (``cli/hook.py``) is waiting on.
    """
    logger.info("incremental index requested for %s (db=%s)", root, db_path)
