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

"""Tests for the Persist-stage drift signals."""

from __future__ import annotations

from opentrace_agent.wiki.ingest.persist import _drift_metrics


def test_drift_no_change_is_not_suspected():
    body = "x" * 500
    m = _drift_metrics(body, body)
    assert m["chars_ratio"] == 1.0
    assert m["token_jaccard"] == 1.0
    assert m["drift_suspected"] is False


def test_drift_empty_before_returns_neutral():
    m = _drift_metrics("", "anything new")
    assert m["chars_ratio"] == 1.0
    assert m["token_jaccard"] == 1.0
    assert m["drift_suspected"] is False


def test_drift_substantial_loss_flags():
    before = " ".join(["alpha", "bravo", "charlie", "delta", "echo"] * 100)
    after = "alpha bravo"  # tiny replacement
    m = _drift_metrics(before, after)
    assert m["chars_ratio"] < 0.5
    assert m["drift_suspected"] is True


def test_drift_short_pages_are_never_flagged():
    """A 50-char stub being halved is noise, not drift."""
    before = "a short page about ducks"  # < 200 chars
    after = "ducks"
    m = _drift_metrics(before, after)
    assert m["chars_ratio"] < 0.5
    # But the absolute length of `before` is below the threshold.
    assert m["drift_suspected"] is False


def test_drift_token_replacement_flags_even_when_size_steady():
    """Same length but completely different words still indicates lost content."""
    # Use equal-length tokens so chars_ratio stays at 1.0 — the failure
    # signal here is supposed to be Jaccard, not size.
    before = " ".join(["alfa"] * 200)
    after = " ".join(["zeta"] * 200)
    m = _drift_metrics(before, after)
    assert m["chars_ratio"] == 1.0
    assert m["token_jaccard"] == 0.0
    assert m["drift_suspected"] is True
