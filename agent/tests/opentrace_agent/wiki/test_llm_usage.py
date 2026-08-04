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

"""Billed-usage capture (UsageTally + the pipeline's llm_usage detail).

Every provider response carries exact token usage; we used to discard it,
which is how the pre-ingest cost estimate drifted 6.5x stale unnoticed. These
tests pin (a) the tally arithmetic, (b) that run_compile surfaces a client's
tally on the DONE event, and (c) that a usage-less injected fake (every
existing test) degrades to "no detail" rather than an error.
"""

from __future__ import annotations

import threading

from opentrace_agent.wiki.llm import UsageTally


class TestUsageTally:
    def test_accumulates(self):
        t = UsageTally()
        t.add(100, 10)
        t.add(250, 25)
        assert t.as_dict() == {"input_tokens": 350, "output_tokens": 35, "calls": 2}

    def test_none_counts_as_zero_but_still_a_call(self):
        # A provider that omits usage metadata (some local endpoints) must not
        # crash the tally or hide that a call happened.
        t = UsageTally()
        t.add(None, None)
        assert t.as_dict() == {"input_tokens": 0, "output_tokens": 0, "calls": 1}

    def test_concurrent_adds_do_not_lose_updates(self):
        # Extraction runs on a ThreadPoolExecutor — the tally is shared.
        t = UsageTally()
        threads = [threading.Thread(target=lambda: [t.add(1, 1) for _ in range(500)]) for _ in range(8)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        assert t.as_dict() == {"input_tokens": 4000, "output_tokens": 4000, "calls": 4000}


class TestPipelineSurfacesUsage:
    def _run(self, tmp_path, llm):
        from opentrace_agent.wiki import SourceInput
        from opentrace_agent.wiki.ingest.pipeline import run_compile

        src = SourceInput(name="a.md", data=b"# Alpha\nEnough content to clear the gate.")
        return list(run_compile("v", [src], vault_root=tmp_path, llm=llm))

    def test_done_event_carries_llm_usage_when_client_has_a_tally(self, tmp_path, fake_llm):
        llm = fake_llm([("emit_extraction", {"one_line_summary": "Alpha doc."})])
        llm.usage = UsageTally()
        real_call = llm.call_tool

        def counted(**kwargs):
            out = real_call(**kwargs)
            llm.usage.add(480, 55)
            return out

        llm.call_tool = counted
        events = self._run(tmp_path, llm)
        done = [e for e in events if (e.detail or {}).get("llm_usage")]
        assert len(done) == 1
        assert done[0].detail["llm_usage"] == {"input_tokens": 480, "output_tokens": 55, "calls": 1}

    def test_usage_less_fake_degrades_to_no_detail(self, tmp_path, fake_llm):
        llm = fake_llm([("emit_extraction", {"one_line_summary": "Alpha doc."})])
        events = self._run(tmp_path, llm)
        assert not any((e.detail or {}).get("llm_usage") for e in events)
