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

"""Integration tests: full pipeline over tests/fixtures/python/project/.

Runs the agent pipeline (processing + resolving) on the project fixture
and asserts on every Variable node, DEFINES edge, and DERIVED_FROM edge
produced from service.py (which exercises all variable/derivation combos).
"""

from __future__ import annotations

from pathlib import Path

from opentrace_agent.pipeline.processing import processing
from opentrace_agent.pipeline.resolving import resolving
from opentrace_agent.pipeline.types import (
    FileEntry,
    GraphNode,
    GraphRelationship,
    PipelineContext,
    PipelineResult,
    ProcessingOutput,
    ScanResult,
    StageResult,
)

FIXTURE_DIR = Path(__file__).resolve().parents[4] / "tests" / "fixtures" / "python" / "project"
REPO_ID = "fixture/py-project"
SVC_FILE_ID = f"{REPO_ID}/service.py"
DB_FILE_ID = f"{REPO_ID}/db.py"
MAIN_FILE_ID = f"{REPO_ID}/main.py"


def _run_pipeline() -> tuple[
    list[GraphNode],
    list[GraphRelationship],
    ProcessingOutput,
    PipelineResult,
]:
    """Run processing + resolving on the full project fixture."""
    files = list(FIXTURE_DIR.glob("*.py"))
    file_entries = []
    path_to_file_id = {}
    for f in sorted(files):
        rel = f.name
        fid = f"{REPO_ID}/{rel}"
        file_entries.append(
            FileEntry(
                file_id=fid,
                abs_path=str(f),
                path=rel,
                extension=".py",
                language="python",
            )
        )
        path_to_file_id[rel] = fid

    scan = ScanResult(
        repo_id=REPO_ID,
        root_path=str(FIXTURE_DIR),
        file_entries=file_entries,
        known_paths=set(path_to_file_id.keys()),
        path_to_file_id=path_to_file_id,
    )

    ctx = PipelineContext()
    proc_out: StageResult[ProcessingOutput] = StageResult()

    all_nodes: list[GraphNode] = []
    all_rels: list[GraphRelationship] = []

    for event in processing(scan, ctx, proc_out):
        if event.nodes:
            all_nodes.extend(event.nodes)
        if event.relationships:
            all_rels.extend(event.relationships)

    proc = proc_out.value
    assert proc is not None

    resolve_out: StageResult[PipelineResult] = StageResult()
    for event in resolving(proc, ctx, resolve_out):
        if event.relationships:
            all_rels.extend(event.relationships)

    result = resolve_out.value
    assert result is not None

    return all_nodes, all_rels, proc, result


# Cache the pipeline run across all tests in this module
_CACHED: tuple[list[GraphNode], list[GraphRelationship], ProcessingOutput, PipelineResult] | None = None


def _get():
    global _CACHED
    if _CACHED is None:
        _CACHED = _run_pipeline()
    return _CACHED


def _nodes():
    return _get()[0]


def _rels():
    return _get()[1]


def _proc():
    return _get()[2]


def _result():
    return _get()[3]


def _var_nodes() -> list[GraphNode]:
    return [n for n in _nodes() if n.type == "Variable"]


def _defines_rels() -> list[GraphRelationship]:
    return [r for r in _rels() if r.type == "DEFINES"]


def _derived_from_rels() -> list[GraphRelationship]:
    return [r for r in _rels() if r.type == "DERIVED_FROM"]


def _var_node(scope: str, name: str) -> GraphNode:
    var_id = f"{SVC_FILE_ID}::{scope}::{name}"
    matches = [n for n in _var_nodes() if n.id == var_id]
    assert len(matches) == 1, f"Expected 1 Variable node {var_id}, found {len(matches)}"
    return matches[0]


def _has_defines(parent_scope: str, child_scope: str, child_name: str) -> bool:
    """Check that parent_scope → DEFINES → child_scope::child_name exists."""
    source = f"{SVC_FILE_ID}::{parent_scope}" if parent_scope else SVC_FILE_ID
    target = f"{SVC_FILE_ID}::{child_scope}::{child_name}"
    return any(r.source_id == source and r.target_id == target for r in _defines_rels())


def _derived_targets(scope: str, var_name: str) -> list[tuple[str, str]]:
    """Return (target_id, transform) pairs for DERIVED_FROM edges from a variable."""
    var_id = f"{SVC_FILE_ID}::{scope}::{var_name}"
    return [(r.target_id, r.properties.get("transform", "")) for r in _derived_from_rels() if r.source_id == var_id]


# ─── UserService: annotated class fields ─────────────────────────────


class TestUserServiceClassFields:
    def test_max_retries_field(self):
        node = _var_node("UserService", "max_retries")
        assert node.properties["kind"] == "field"
        assert node.properties["typeAnnotation"] == "int"

    def test_service_name_bare_annotation(self):
        node = _var_node("UserService", "service_name")
        assert node.properties["kind"] == "field"
        assert node.properties["typeAnnotation"] == "str"

    def test_defines_annotated_fields(self):
        assert _has_defines("UserService", "UserService", "max_retries")
        assert _has_defines("UserService", "UserService", "service_name")


# ─── UserService: __init__ self.x fields ─────────────────────────────


class TestUserServiceInitFields:
    def test_self_from_identifier(self):
        """self.db = db → field from parameter."""
        node = _var_node("UserService", "db")
        assert node.properties["kind"] == "field"

    def test_self_from_attribute(self):
        """self.conn = db.conn → field from attribute access."""
        node = _var_node("UserService", "conn")
        assert node.properties["kind"] == "field"

    def test_self_from_bare_call(self):
        """self.logger = make_logger() → field from bare call."""
        node = _var_node("UserService", "logger")
        assert node.properties["kind"] == "field"

    def test_self_in_nested_if(self):
        """self.debug_handler in nested if block."""
        node = _var_node("UserService", "debug_handler")
        assert node.properties["kind"] == "field"

    def test_defines_init_fields(self):
        for name in ("db", "conn", "logger", "debug_handler"):
            assert _has_defines("UserService", "UserService", name), f"Missing DEFINES for UserService::{name}"


# ─── UserService.__init__: parameters ────────────────────────────────


class TestUserServiceInitParams:
    def test_db_param(self):
        node = _var_node("UserService::__init__", "db")
        assert node.properties["kind"] == "parameter"
        assert node.properties["typeAnnotation"] == "Database"

    def test_debug_param_with_default(self):
        node = _var_node("UserService::__init__", "debug")
        assert node.properties["kind"] == "parameter"
        assert node.properties["typeAnnotation"] == "bool"

    def test_self_skipped(self):
        var_ids = {n.id for n in _var_nodes()}
        assert f"{SVC_FILE_ID}::UserService::__init__::self" not in var_ids

    def test_defines_params(self):
        assert _has_defines("UserService::__init__", "UserService::__init__", "db")
        assert _has_defines("UserService::__init__", "UserService::__init__", "debug")


# ─── UserService.get_user: parameters + locals ───────────────────────


class TestGetUser:
    def test_param(self):
        node = _var_node("UserService::get_user", "user_id")
        assert node.properties["kind"] == "parameter"
        assert node.properties["typeAnnotation"] == "int"

    def test_local_from_method_call(self):
        """rows = self.db.get_all_users()"""
        node = _var_node("UserService::get_user", "rows")
        assert node.properties["kind"] == "local"

    def test_local_from_identifier(self):
        """data = rows"""
        node = _var_node("UserService::get_user", "data")
        assert node.properties["kind"] == "local"

    def test_local_from_attribute(self):
        """count = rows.__len__"""
        node = _var_node("UserService::get_user", "count")
        assert node.properties["kind"] == "local"

    def test_annotated_local(self):
        """result: dict = {}"""
        node = _var_node("UserService::get_user", "result")
        assert node.properties["kind"] == "local"
        assert node.properties["typeAnnotation"] == "dict"

    def test_local_in_if_else(self):
        """user assigned in if/else block."""
        node = _var_node("UserService::get_user", "user")
        assert node.properties["kind"] == "local"

    def test_defines_locals(self):
        scope = "UserService::get_user"
        for name in ("rows", "data", "count", "result", "user"):
            assert _has_defines(scope, scope, name), f"Missing DEFINES for {scope}::{name}"


# ─── UserService.create_user_batch: compound + control flow ──────────


class TestCreateUserBatch:
    def test_params(self):
        names = _var_node("UserService::create_user_batch", "names")
        assert names.properties["kind"] == "parameter"
        assert names.properties["typeAnnotation"] == "list"
        emails = _var_node("UserService::create_user_batch", "emails")
        assert emails.properties["kind"] == "parameter"
        assert emails.properties["typeAnnotation"] == "list"

    def test_for_loop_var(self):
        """for i in range(total) → loop variable."""
        node = _var_node("UserService::create_user_batch", "i")
        assert node.properties["kind"] == "local"

    def test_local_compound(self):
        """total = len(names) + len(emails) → compound expression."""
        node = _var_node("UserService::create_user_batch", "total")
        assert node.properties["kind"] == "local"

    def test_local_literal(self):
        """created = 0 → literal, no derivation."""
        node = _var_node("UserService::create_user_batch", "created")
        assert node.properties["kind"] == "local"

    def test_local_in_for_loop(self):
        """result assigned inside for loop body."""
        node = _var_node("UserService::create_user_batch", "result")
        assert node.properties["kind"] == "local"

    def test_local_in_try_except(self):
        """summary assigned in try/except."""
        node = _var_node("UserService::create_user_batch", "summary")
        assert node.properties["kind"] == "local"

    def test_defines_all(self):
        scope = "UserService::create_user_batch"
        for name in ("names", "emails", "total", "created", "i", "result", "summary"):
            assert _has_defines(scope, scope, name), f"Missing DEFINES for {scope}::{name}"


# ─── validate_email: top-level function ──────────────────────────────


class TestValidateEmail:
    def test_typed_param(self):
        node = _var_node("validate_email", "address")
        assert node.properties["kind"] == "parameter"
        assert node.properties["typeAnnotation"] == "str"

    def test_default_param(self):
        node = _var_node("validate_email", "strict")
        assert node.properties["kind"] == "parameter"
        assert node.properties["typeAnnotation"] == "bool"

    def test_local_unresolved_call(self):
        """pattern = compile_pattern() → unresolved (not in file)."""
        node = _var_node("validate_email", "pattern")
        assert node.properties["kind"] == "local"

    def test_local_list_derivation(self):
        """parts = [address, pattern] → list with identifiers."""
        node = _var_node("validate_email", "parts")
        assert node.properties["kind"] == "local"

    def test_local_literal(self):
        """valid = False → literal, no derivation."""
        node = _var_node("validate_email", "valid")
        assert node.properties["kind"] == "local"

    def test_defines_params_and_locals(self):
        for name in ("address", "strict", "pattern", "parts", "valid"):
            assert _has_defines("validate_email", "validate_email", name), f"Missing DEFINES for validate_email::{name}"


# ─── DERIVED_FROM edges ─────────────────────────────────────────────


class TestDerivedFromEdges:
    def test_self_db_from_identifier(self):
        """self.db = db → DERIVED_FROM → __init__::db parameter."""
        targets = _derived_targets("UserService", "db")
        target_ids = {t[0] for t in targets}
        assert f"{SVC_FILE_ID}::UserService::__init__::db" in target_ids

    def test_self_conn_from_attribute(self):
        """self.conn = db.conn → attribute, receiver 'db' resolves in __init__ scope.

        'db' is a parameter in __init__, not an import alias. The attribute
        resolver only checks the import registry, so this is still unresolved.
        """
        targets = _derived_targets("UserService", "conn")
        assert len(targets) == 0

    def test_self_logger_unresolved(self):
        """self.logger = make_logger() → not defined in file → unresolved."""
        targets = _derived_targets("UserService", "logger")
        assert len(targets) == 0

    def test_get_user_data_from_identifier(self):
        """data = rows → DERIVED_FROM → rows (same scope)."""
        targets = _derived_targets("UserService::get_user", "data")
        target_ids = {t[0] for t in targets}
        assert f"{SVC_FILE_ID}::UserService::get_user::rows" in target_ids

    def test_create_user_batch_reassignment_merges(self):
        """created = 0; created = created + 1 → merges derivation from reassignment."""
        targets = _derived_targets("UserService::create_user_batch", "created")
        # Second assignment `created = created + 1` adds a self-referencing derivation
        target_ids = {t[0] for t in targets}
        assert f"{SVC_FILE_ID}::UserService::create_user_batch::created" in target_ids

    def test_validate_email_list_derivation(self):
        """parts = [address, pattern] → derives from both parameters/locals."""
        targets = _derived_targets("validate_email", "parts")
        target_ids = {t[0] for t in targets}
        assert f"{SVC_FILE_ID}::validate_email::address" in target_ids
        assert f"{SVC_FILE_ID}::validate_email::pattern" in target_ids

    def test_validate_email_literal_no_derivation(self):
        """valid = False → no DERIVED_FROM edges."""
        targets = _derived_targets("validate_email", "valid")
        assert len(targets) == 0

    def test_status_retries_from_self_field(self):
        """retries = self.max_retries → DERIVED_FROM → class field."""
        targets = _derived_targets("UserService::status", "retries")
        target_ids = {t[0] for t in targets}
        assert f"{SVC_FILE_ID}::UserService::max_retries" in target_ids
        assert any(t[1] == "attribute" for t in targets)

    def test_status_remaining_compound_with_literal(self):
        """remaining = retries - 1 → derives from retries only (literal ignored)."""
        targets = _derived_targets("UserService::status", "remaining")
        target_ids = {t[0] for t in targets}
        assert f"{SVC_FILE_ID}::UserService::status::retries" in target_ids
        # '1' is a literal — should not appear as a derivation
        assert len(targets) == 1

    def test_process_batch_data_from_param(self):
        """data = items → DERIVED_FROM → items parameter."""
        targets = _derived_targets("process_batch", "data")
        target_ids = {t[0] for t in targets}
        assert f"{SVC_FILE_ID}::process_batch::items" in target_ids

    def test_process_batch_chained_call_resolves_args(self):
        """result = transform(parse(data)) → data resolved from call args."""
        targets = _derived_targets("process_batch", "result")
        target_ids = {t[0] for t in targets}
        # transform/parse are unresolved, but data (passed as arg) is resolved
        assert f"{SVC_FILE_ID}::process_batch::data" in target_ids


# ─── UserService.status: self-field reads ────────────────────────────


class TestStatusMethod:
    def test_retries_local(self):
        node = _var_node("UserService::status", "retries")
        assert node.properties["kind"] == "local"

    def test_remaining_local(self):
        node = _var_node("UserService::status", "remaining")
        assert node.properties["kind"] == "local"

    def test_name_local(self):
        node = _var_node("UserService::status", "name")
        assert node.properties["kind"] == "local"

    def test_defines_locals(self):
        scope = "UserService::status"
        for name in ("retries", "remaining", "name"):
            assert _has_defines(scope, scope, name), f"Missing DEFINES for {scope}::{name}"


# ─── process_batch: untyped params ───────────────────────────────────


class TestProcessBatch:
    def test_untyped_param(self):
        node = _var_node("process_batch", "items")
        assert node.properties["kind"] == "parameter"
        assert node.properties.get("typeAnnotation") is None

    def test_typed_default_param(self):
        node = _var_node("process_batch", "limit")
        assert node.properties["kind"] == "parameter"
        assert node.properties["typeAnnotation"] == "int"

    def test_local_from_identifier(self):
        node = _var_node("process_batch", "data")
        assert node.properties["kind"] == "local"

    def test_local_chained_call(self):
        node = _var_node("process_batch", "result")
        assert node.properties["kind"] == "local"

    def test_defines_all(self):
        for name in ("items", "limit", "data", "result"):
            assert _has_defines("process_batch", "process_batch", name), f"Missing DEFINES for process_batch::{name}"


# ─── advanced_patterns: *args, **kwargs, tuple unpack, for, with ─────


class TestAdvancedPatterns:
    def test_star_args_param(self):
        node = _var_node("advanced_patterns", "args")
        assert node.properties["kind"] == "parameter"

    def test_star_kwargs_param(self):
        node = _var_node("advanced_patterns", "kwargs")
        assert node.properties["kind"] == "parameter"

    def test_tuple_unpack_first(self):
        node = _var_node("advanced_patterns", "first")
        assert node.properties["kind"] == "local"

    def test_tuple_unpack_second(self):
        node = _var_node("advanced_patterns", "second")
        assert node.properties["kind"] == "local"

    def test_tuple_unpack_derivation(self):
        """first, second = args → both derive from args (identifier)."""
        for name in ("first", "second"):
            targets = _derived_targets("advanced_patterns", name)
            target_ids = {t[0] for t in targets}
            assert f"{SVC_FILE_ID}::advanced_patterns::args" in target_ids

    def test_for_loop_variable(self):
        node = _var_node("advanced_patterns", "key")
        assert node.properties["kind"] == "local"

    def test_with_as_variable(self):
        node = _var_node("advanced_patterns", "logfile")
        assert node.properties["kind"] == "local"

    def test_defines_all(self):
        for name in ("args", "kwargs", "first", "second", "key", "logfile"):
            assert _has_defines("advanced_patterns", "advanced_patterns", name), (
                f"Missing DEFINES for advanced_patterns::{name}"
            )


# ─── Cross-file: db.py variables ─────────────────────────────────────


class TestDbFileVariables:
    """Verify db.py also produces Variable nodes (it's in the same fixture)."""

    def _db_var(self, scope: str, name: str) -> GraphNode:
        var_id = f"{DB_FILE_ID}::{scope}::{name}"
        matches = [n for n in _var_nodes() if n.id == var_id]
        assert len(matches) == 1, f"Expected 1 Variable node {var_id}, found {len(matches)}"
        return matches[0]

    def test_init_path_param(self):
        node = self._db_var("Database::__init__", "path")
        assert node.properties["kind"] == "parameter"
        assert node.properties["typeAnnotation"] == "str"

    def test_init_self_path_field(self):
        node = self._db_var("Database", "path")
        assert node.properties["kind"] == "field"

    def test_self_path_derived_from_param(self):
        """self.path = path → DERIVED_FROM → __init__::path parameter."""
        var_id = f"{DB_FILE_ID}::Database::path"
        derivs = [
            (r.target_id, r.properties.get("transform", "")) for r in _derived_from_rels() if r.source_id == var_id
        ]
        target_ids = {t[0] for t in derivs}
        assert f"{DB_FILE_ID}::Database::__init__::path" in target_ids

    def test_init_self_conn_field(self):
        node = self._db_var("Database", "conn")
        assert node.properties["kind"] == "field"

    def test_get_all_users_cursor_local(self):
        node = self._db_var("Database::get_all_users", "cursor")
        assert node.properties["kind"] == "local"

    def test_get_all_users_rows_local(self):
        node = self._db_var("Database::get_all_users", "rows")
        assert node.properties["kind"] == "local"

    def test_insert_user_params(self):
        name = self._db_var("Database::insert_user", "name")
        assert name.properties["kind"] == "parameter"
        assert name.properties["typeAnnotation"] == "str"
        email = self._db_var("Database::insert_user", "email")
        assert email.properties["kind"] == "parameter"
        assert email.properties["typeAnnotation"] == "str"

    def test_insert_user_cursor_local(self):
        node = self._db_var("Database::insert_user", "cursor")
        assert node.properties["kind"] == "local"


# ─── Cross-file: main.py variables ───────────────────────────────────


class TestMainFileVariables:
    """Verify main.py variables and cross-file DERIVED_FROM edges."""

    def _main_var(self, scope: str, name: str) -> GraphNode:
        var_id = f"{MAIN_FILE_ID}::{scope}::{name}"
        matches = [n for n in _var_nodes() if n.id == var_id]
        assert len(matches) == 1, f"Expected 1 Variable node {var_id}, found {len(matches)}"
        return matches[0]

    def test_list_users_local(self):
        """users = db.get_all_users() → cross-file call derivation."""
        node = self._main_var("list_users", "users")
        assert node.properties["kind"] == "local"

    def test_list_users_derivation(self):
        """users → DERIVED_FROM → Database::get_all_users (cross-file)."""
        var_id = f"{MAIN_FILE_ID}::list_users::users"
        derivs = [
            (r.target_id, r.properties.get("transform", "")) for r in _derived_from_rels() if r.source_id == var_id
        ]
        target_ids = {t[0] for t in derivs}
        assert f"{DB_FILE_ID}::Database::get_all_users" in target_ids

    def test_create_user_data_local(self):
        node = self._main_var("create_user", "data")
        assert node.properties["kind"] == "local"

    def test_create_user_local(self):
        """user = db.insert_user(...) → cross-file call derivation."""
        node = self._main_var("create_user", "user")
        assert node.properties["kind"] == "local"

    def test_create_user_derivation(self):
        """user → DERIVED_FROM → Database::insert_user (cross-file)."""
        var_id = f"{MAIN_FILE_ID}::create_user::user"
        derivs = [
            (r.target_id, r.properties.get("transform", "")) for r in _derived_from_rels() if r.source_id == var_id
        ]
        target_ids = {t[0] for t in derivs}
        assert f"{DB_FILE_ID}::Database::insert_user" in target_ids


# ─── Pipeline stats ──────────────────────────────────────────────────


class TestPipelineStats:
    def test_variables_extracted_count(self):
        proc = _proc()
        # service.py + db.py + main.py all contribute variables
        assert proc.variables_extracted >= 20

    def test_variable_registry_populated(self):
        proc = _proc()
        scopes = proc.registries.variable_registry
        assert f"{SVC_FILE_ID}::UserService" in scopes
        assert f"{SVC_FILE_ID}::UserService::__init__" in scopes
        assert f"{SVC_FILE_ID}::UserService::get_user" in scopes
        assert f"{SVC_FILE_ID}::UserService::status" in scopes
        assert f"{SVC_FILE_ID}::validate_email" in scopes
        assert f"{SVC_FILE_ID}::process_batch" in scopes
        assert f"{SVC_FILE_ID}::advanced_patterns" in scopes
        assert f"{DB_FILE_ID}::Database" in scopes

    def test_derivation_infos_collected(self):
        proc = _proc()
        assert len(proc.derivation_infos) > 0

    def test_derivations_resolved_count(self):
        result = _result()
        assert result.derivations_resolved > 0
