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

"""Tests for the watcher's building blocks."""

from __future__ import annotations

import threading
import time

import pytest

from opentrace_agent.cli.watch import (
    DEFAULT_IGNORE_PREFIXES,
    Debouncer,
    should_ignore,
)


class TestShouldIgnore:
    def test_git_dir_ignored(self):
        assert should_ignore(".git/HEAD")
        assert should_ignore(".git/refs/heads/main")

    def test_node_modules_ignored(self):
        assert should_ignore("node_modules/foo/index.js")

    def test_nested_pycache_ignored(self):
        assert should_ignore("src/__pycache__/foo.cpython.pyc")

    def test_normal_source_kept(self):
        assert not should_ignore("src/foo.py")
        assert not should_ignore("README.md")

    def test_hidden_dotfile_at_root_kept(self):
        assert not should_ignore(".env")

    def test_custom_ignore_prefixes(self):
        assert should_ignore("private/", ignore_prefixes=("private/",))
        assert not should_ignore("public/", ignore_prefixes=("private/",))


class TestDebouncer:
    def test_single_call_fires_after_delay(self):
        fired = threading.Event()
        d = Debouncer(delay=0.05, callback=fired.set)
        d.schedule()
        assert fired.wait(timeout=0.5)

    def test_re_arm_cancels_prior(self):
        count = [0]

        def cb():
            count[0] += 1

        d = Debouncer(delay=0.05, callback=cb)
        d.schedule()
        time.sleep(0.02)
        d.schedule()  # re-arms
        time.sleep(0.02)
        d.schedule()  # re-arms again
        time.sleep(0.2)
        # Should have fired exactly once despite three schedules.
        assert count[0] == 1

    def test_cancel_prevents_fire(self):
        count = [0]

        def cb():
            count[0] += 1

        d = Debouncer(delay=0.05, callback=cb)
        d.schedule()
        d.cancel()
        time.sleep(0.15)
        assert count[0] == 0

    def test_callback_exception_does_not_kill_thread(self):
        def boom():
            raise RuntimeError("intentional")

        d = Debouncer(delay=0.01, callback=boom)
        d.schedule()
        time.sleep(0.1)
        # If the thread had crashed, a second schedule would still fire and
        # we'd see no exception leaking up here.
        d.schedule()
        time.sleep(0.1)


class TestEventHandler:
    def test_requires_watchdog(self, monkeypatch):
        # Force the watchdog import to fail.
        import sys

        watchdog_modules = [m for m in sys.modules if m.startswith("watchdog")]
        saved = {m: sys.modules[m] for m in watchdog_modules}
        for m in watchdog_modules:
            sys.modules.pop(m)
        sys.modules["watchdog"] = None  # type: ignore[assignment]
        sys.modules["watchdog.events"] = None  # type: ignore[assignment]

        try:
            from opentrace_agent.cli.watch import build_event_handler

            with pytest.raises(RuntimeError, match="watchdog not installed"):
                build_event_handler(__import__("pathlib").Path("."), lambda _r: None)
        finally:
            sys.modules.pop("watchdog", None)
            sys.modules.pop("watchdog.events", None)
            for k, v in saved.items():
                sys.modules[k] = v

    def test_real_handler_invokes_callback(self, tmp_path):
        from opentrace_agent.cli.watch import build_event_handler

        seen: list[str] = []
        handler = build_event_handler(tmp_path, seen.append)

        # Fake event types — the handler will resolve paths against tmp_path.
        from watchdog.events import FileModifiedEvent  # type: ignore[import-not-found]

        target = tmp_path / "foo.py"
        target.write_text("x = 1")
        handler.on_any_event(FileModifiedEvent(str(target)))
        assert seen == ["foo.py"]

    def test_handler_skips_ignored_paths(self, tmp_path):
        from opentrace_agent.cli.watch import build_event_handler

        seen: list[str] = []
        handler = build_event_handler(tmp_path, seen.append)

        from watchdog.events import FileModifiedEvent  # type: ignore[import-not-found]

        ignored_dir = tmp_path / ".git"
        ignored_dir.mkdir()
        ignored = ignored_dir / "HEAD"
        ignored.write_text("ref: refs/heads/main")
        handler.on_any_event(FileModifiedEvent(str(ignored)))
        assert seen == []

    def test_defaults_contain_expected_noise(self):
        # Sanity check: the default ignore list catches the obvious offenders.
        for required in (".git/", "node_modules/", "__pycache__/"):
            assert required in DEFAULT_IGNORE_PREFIXES
