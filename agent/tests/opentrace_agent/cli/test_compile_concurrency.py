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

"""Proves the compile stream doesn't block the event loop.

Drives the real ASGI app with an async client: starts a compile whose fake
pipeline blocks mid-stream, then asserts GET /api/vaults still answers promptly
(it would hang until the compile finished if the blocking generator ran on the
event loop instead of the threadpool).
"""

from __future__ import annotations

import threading

import pytest

real_ladybug = pytest.importorskip("real_ladybug")

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def test_reads_stay_responsive_during_compile(tmp_path, monkeypatch):
    import anyio
    import httpx

    import opentrace_agent.wiki as wiki_mod
    from opentrace_agent.cli.serve import create_app
    from opentrace_agent.store import GraphStore
    from opentrace_agent.wiki.ingest.types import WikiEventKind, WikiPhase, WikiPipelineEvent
    from opentrace_agent.wiki.paths import ensure_vault_layout, metadata_path

    project_root = tmp_path / "proj"
    (project_root / ".opentrace").mkdir(parents=True)
    monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))
    # A pre-existing local vault that must remain visible during the compile.
    ensure_vault_layout("already", scope="local", project_root=project_root)
    metadata_path("already", scope="local", project_root=project_root).write_text('{"name": "already"}')

    store = GraphStore(str(project_root / ".opentrace" / "index.db"))

    gate = threading.Event()

    def fake_run_compile(name, inputs, **kwargs):
        yield WikiPipelineEvent(kind=WikiEventKind.STAGE_START, phase=WikiPhase.EXTRACTING, message="working")
        # Block INSIDE the generator, as a real LLM call would. If this runs on
        # the event loop, every other request stalls until gate.set().
        gate.wait(timeout=10)
        yield WikiPipelineEvent(kind=WikiEventKind.DONE, phase=WikiPhase.PERSISTING, message="done")

    monkeypatch.setattr(wiki_mod, "run_compile", fake_run_compile)

    transport = httpx.ASGITransport(app=create_app(store))
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:

            async def drive_compile():
                async with client.stream(
                    "POST",
                    "/api/vaults/inflight/compile",
                    data={"scope": "local", "provider": "anthropic", "api_key": "k"},
                    files={"files": ("a.md", b"# hi", "text/markdown")},
                ) as r:
                    async for _ in r.aiter_lines():
                        pass

            async with anyio.create_task_group() as tg:
                tg.start_soon(drive_compile)
                await anyio.sleep(0.3)  # let the compile reach the gate

                # This read must return promptly even though the compile is
                # blocked mid-stream. Times out (=fails) if the loop is starved.
                with anyio.fail_after(3):
                    resp = await client.get("/api/vaults?view=project")
                assert resp.status_code == 200
                names = {v["name"] for v in resp.json()["vaults"]}
                assert "already" in names, f"existing vault vanished during compile: {names}"

                gate.set()  # let the compile finish
    finally:
        gate.set()
        store.close()
