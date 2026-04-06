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

"""Shared fixtures for CLI tests."""

from __future__ import annotations

import pytest

real_ladybug = pytest.importorskip("real_ladybug")

from starlette.testclient import TestClient  # noqa: E402

from opentrace_agent.cli.serve import create_app  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    """Create a GraphStore with some test data."""
    db_path = str(tmp_path / "test.db")
    s = GraphStore(db_path)
    s.add_node("node-1", "Class", "UserService", {"language": "python", "path": "src/user.py"})
    s.add_node("node-2", "Function", "get_user", {"language": "python", "path": "src/user.py"})
    s.add_node("node-3", "Class", "OrderService", {"language": "python", "path": "src/order.py"})
    s.add_relationship("rel-1", "DEFINES", "node-1", "node-2")
    s.add_relationship("rel-2", "CALLS", "node-3", "node-2")
    yield s
    s.close()


@pytest.fixture()
def client(store):
    """Starlette test client wrapping the serve app."""
    app = create_app(store)
    return TestClient(app)
