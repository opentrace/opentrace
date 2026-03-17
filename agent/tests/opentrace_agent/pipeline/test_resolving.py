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

"""Tests for the resolving pipeline stage."""

from __future__ import annotations

from opentrace_agent.pipeline.resolving import resolve_calls, resolving
from opentrace_agent.pipeline.types import (
    CallInfo,
    EventKind,
    Phase,
    PipelineContext,
    PipelineResult,
    ProcessingOutput,
    Registries,
    StageResult,
    SymbolInfo,
)


def _build_registries() -> tuple[Registries, list[CallInfo]]:
    """Build pre-populated registries for testing resolution."""
    regs = Registries()

    # File: myapp/server.py
    file_id = "myapp/server.py"

    server_cls = SymbolInfo(
        node_id=f"{file_id}::Server",
        name="Server",
        kind="class",
        file_id=file_id,
        language="python",
    )
    handle_method = SymbolInfo(
        node_id=f"{file_id}::Server::handle",
        name="handle",
        kind="function",
        file_id=file_id,
        language="python",
    )
    validate_method = SymbolInfo(
        node_id=f"{file_id}::Server::validate",
        name="validate",
        kind="function",
        file_id=file_id,
        language="python",
    )
    server_cls.children = [handle_method, validate_method]

    standalone_fn = SymbolInfo(
        node_id=f"{file_id}::process",
        name="process",
        kind="function",
        file_id=file_id,
        language="python",
    )

    # File: myapp/utils.py
    utils_file_id = "myapp/utils.py"
    helper_fn = SymbolInfo(
        node_id=f"{utils_file_id}::helper",
        name="helper",
        kind="function",
        file_id=utils_file_id,
        language="python",
    )

    # Register everything
    for si in [server_cls, handle_method, validate_method, standalone_fn, helper_fn]:
        regs.name_registry.setdefault(si.name, []).append(si)
        regs.file_registry.setdefault(si.file_id, {})[si.name] = si
        if si.kind == "class":
            regs.class_registry.setdefault(si.name, []).append(si)

    # Import: server.py imports utils
    regs.import_registry[file_id] = {"utils": utils_file_id}

    # Call infos
    call_infos = [
        # handle() calls self.validate()
        CallInfo(
            caller_id=f"{file_id}::Server::handle",
            caller_name="handle",
            file_id=file_id,
            calls=[("validate", "self", "attribute")],
        ),
        # process() calls Server() (constructor)
        CallInfo(
            caller_id=f"{file_id}::process",
            caller_name="process",
            file_id=file_id,
            calls=[
                ("Server", None, "bare"),  # constructor
                ("helper", "utils", "attribute"),  # import-based
            ],
        ),
    ]

    return regs, call_infos


def test_self_resolution() -> None:
    """Strategy 1: self.validate() → validate method on same class."""
    regs, call_infos = _build_registries()
    # Only the handle() call
    rels = resolve_calls([call_infos[0]], regs)

    assert len(rels) == 1
    assert rels[0].source_id == "myapp/server.py::Server::handle"
    assert rels[0].target_id == "myapp/server.py::Server::validate"
    assert rels[0].properties["confidence"] == 1.0


def test_constructor_resolution() -> None:
    """Strategy 5: Server() bare call → Server class."""
    regs, call_infos = _build_registries()
    # process() calls: Server() + utils.helper()
    rels = resolve_calls([call_infos[1]], regs)

    # Should resolve Server() → Server class node
    server_rels = [r for r in rels if "Server" in r.target_id and "::" not in r.target_id.split("Server", 1)[1]]
    assert len(server_rels) == 1
    assert server_rels[0].target_id == "myapp/server.py::Server"


def test_import_based_resolution() -> None:
    """Strategy 4: utils.helper() → helper function in utils.py."""
    regs, call_infos = _build_registries()
    rels = resolve_calls([call_infos[1]], regs)

    helper_rels = [r for r in rels if r.target_id.endswith("::helper")]
    assert len(helper_rels) == 1
    assert helper_rels[0].properties["confidence"] == 0.9


def test_intra_file_bare_call() -> None:
    """Strategy 6: bare call to function in same file."""
    regs = Registries()
    file_id = "test/app.py"

    foo = SymbolInfo(node_id=f"{file_id}::foo", name="foo", kind="function", file_id=file_id, language="python")
    bar = SymbolInfo(node_id=f"{file_id}::bar", name="bar", kind="function", file_id=file_id, language="python")

    regs.name_registry["foo"] = [foo]
    regs.name_registry["bar"] = [bar]
    regs.file_registry[file_id] = {"foo": foo, "bar": bar}

    call_infos = [
        CallInfo(
            caller_id=f"{file_id}::foo",
            caller_name="foo",
            file_id=file_id,
            calls=[("bar", None, "bare")],
        ),
    ]

    rels = resolve_calls(call_infos, regs)
    assert len(rels) == 1
    assert rels[0].target_id == f"{file_id}::bar"
    assert rels[0].properties["confidence"] == 1.0


def test_cross_file_unique_match() -> None:
    """Strategy 7: bare call with unique cross-file match."""
    regs = Registries()
    file_a = "test/a.py"
    file_b = "test/b.py"

    caller = SymbolInfo(node_id=f"{file_a}::main", name="main", kind="function", file_id=file_a, language="python")
    target = SymbolInfo(
        node_id=f"{file_b}::unique_fn", name="unique_fn", kind="function", file_id=file_b, language="python"
    )

    regs.name_registry["main"] = [caller]
    regs.name_registry["unique_fn"] = [target]
    regs.file_registry[file_a] = {"main": caller}
    regs.file_registry[file_b] = {"unique_fn": target}

    call_infos = [
        CallInfo(
            caller_id=f"{file_a}::main",
            caller_name="main",
            file_id=file_a,
            calls=[("unique_fn", None, "bare")],
        ),
    ]

    rels = resolve_calls(call_infos, regs)
    assert len(rels) == 1
    assert rels[0].target_id == f"{file_b}::unique_fn"
    assert rels[0].properties["confidence"] == 0.8


def test_dedup_calls() -> None:
    """Duplicate calls to the same target are deduplicated."""
    regs = Registries()
    file_id = "test/app.py"

    foo = SymbolInfo(node_id=f"{file_id}::foo", name="foo", kind="function", file_id=file_id, language="python")
    bar = SymbolInfo(node_id=f"{file_id}::bar", name="bar", kind="function", file_id=file_id, language="python")

    regs.name_registry["foo"] = [foo]
    regs.name_registry["bar"] = [bar]
    regs.file_registry[file_id] = {"foo": foo, "bar": bar}

    call_infos = [
        CallInfo(
            caller_id=f"{file_id}::foo",
            caller_name="foo",
            file_id=file_id,
            calls=[
                ("bar", None, "bare"),
                ("bar", None, "bare"),  # duplicate
            ],
        ),
    ]

    rels = resolve_calls(call_infos, regs)
    assert len(rels) == 1


def test_skip_recursive_call() -> None:
    """A function calling itself (same name, no receiver) is skipped."""
    regs = Registries()
    file_id = "test/app.py"

    foo = SymbolInfo(node_id=f"{file_id}::foo", name="foo", kind="function", file_id=file_id, language="python")

    regs.name_registry["foo"] = [foo]
    regs.file_registry[file_id] = {"foo": foo}

    call_infos = [
        CallInfo(
            caller_id=f"{file_id}::foo",
            caller_name="foo",
            file_id=file_id,
            calls=[("foo", None, "bare")],
        ),
    ]

    rels = resolve_calls(call_infos, regs)
    assert len(rels) == 0


def test_resolving_stage_events() -> None:
    """The resolving generator emits correct events."""
    regs, call_infos = _build_registries()
    proc = ProcessingOutput(
        registries=regs,
        call_infos=call_infos,
        nodes_created=10,
        relationships_created=5,
        files_processed=2,
        classes_extracted=1,
        functions_extracted=4,
    )
    ctx = PipelineContext()
    out: StageResult[PipelineResult] = StageResult()

    events = list(resolving(proc, ctx, out))

    assert events[0].kind == EventKind.STAGE_START
    assert events[0].phase == Phase.RESOLVING
    assert events[-1].kind == EventKind.STAGE_STOP

    result = out.value
    assert result is not None
    assert result.files_processed == 2
    assert result.classes_extracted == 1
    assert result.relationships_created > 5  # 5 original + resolved calls
