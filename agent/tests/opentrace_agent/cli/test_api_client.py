"""Tests for opentrace_agent.cli.api_client."""

from __future__ import annotations

import httpx
import pytest
from pytest_httpx import HTTPXMock

from opentrace_agent.cli.api_client import BatchImportClient, ImportError


class TestCheckConnectivity:
    def test_success(self, httpx_mock: HTTPXMock):
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/graph/stats",
            json={"nodes": 42},
        )

        client = BatchImportClient("http://localhost:8080")
        stats = client.check_connectivity()
        assert stats == {"nodes": 42}

    def test_connection_refused(self, httpx_mock: HTTPXMock):
        httpx_mock.add_exception(
            httpx.ConnectError("Connection refused"),
            url="http://localhost:8080/api/v1/graph/stats",
        )

        client = BatchImportClient("http://localhost:8080")
        with pytest.raises(ConnectionError, match="Cannot connect"):
            client.check_connectivity()

    def test_server_error(self, httpx_mock: HTTPXMock):
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/graph/stats",
            status_code=500,
        )

        client = BatchImportClient("http://localhost:8080")
        with pytest.raises(ConnectionError, match="returned 500"):
            client.check_connectivity()


class TestImportAll:
    def _sample_nodes(self, count: int = 3) -> list[dict]:
        return [{"id": f"n{i}", "type": "File", "name": f"file{i}", "properties": {}} for i in range(count)]

    def _sample_rels(self, count: int = 2) -> list[dict]:
        return [
            {
                "id": f"r{i}",
                "type": "DEFINED_IN",
                "source_id": f"n{i}",
                "target_id": "n0",
                "properties": {},
            }
            for i in range(1, count + 1)
        ]

    def test_upload_nodes_then_rels(self, httpx_mock: HTTPXMock):
        """Should POST nodes first, then relationships."""
        # Register two responses — first for nodes batch, second for rels batch
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/graph/import",
            json={"nodes_created": 3, "relationships_created": 0, "errors": []},
        )
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/graph/import",
            json={"nodes_created": 0, "relationships_created": 2, "errors": []},
        )

        client = BatchImportClient("http://localhost:8080")
        result = client.import_all(self._sample_nodes(), self._sample_rels(), batch_size=100)

        assert result["nodes_created"] == 3
        assert result["relationships_created"] == 2

        # Verify order: first request has nodes, second has relationships
        import json

        requests = httpx_mock.get_requests()
        first_body = json.loads(requests[0].content)
        second_body = json.loads(requests[1].content)
        assert len(first_body["nodes"]) == 3
        assert len(first_body["relationships"]) == 0
        assert len(second_body["nodes"]) == 0
        assert len(second_body["relationships"]) == 2

    def test_batching(self, httpx_mock: HTTPXMock):
        """With batch_size=2, 3 nodes should produce 2 batches."""
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/graph/import",
            json={"nodes_created": 2, "relationships_created": 0, "errors": []},
        )
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/graph/import",
            json={"nodes_created": 1, "relationships_created": 0, "errors": []},
        )

        client = BatchImportClient("http://localhost:8080")
        result = client.import_all(self._sample_nodes(3), [], batch_size=2)

        assert result["nodes_created"] == 3

    def test_4xx_fails_fast(self, httpx_mock: HTTPXMock):
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/graph/import",
            status_code=400,
            text="bad request",
        )

        client = BatchImportClient("http://localhost:8080")
        with pytest.raises(ImportError, match="400"):
            client.import_all(self._sample_nodes(1), [])

    def test_progress_callback(self, httpx_mock: HTTPXMock):
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/graph/import",
            json={"nodes_created": 1, "relationships_created": 0, "errors": []},
        )

        messages: list[str] = []
        client = BatchImportClient("http://localhost:8080")
        client.import_all(
            self._sample_nodes(1),
            [],
            on_progress=messages.append,
        )

        assert any("nodes" in m.lower() for m in messages)

    def test_empty_input(self, httpx_mock: HTTPXMock):
        """No API calls when both lists are empty."""
        client = BatchImportClient("http://localhost:8080")
        result = client.import_all([], [])

        assert result["nodes_created"] == 0
        assert result["relationships_created"] == 0

    def test_reports_api_errors(self, httpx_mock: HTTPXMock):
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/graph/import",
            json={
                "nodes_created": 1,
                "relationships_created": 0,
                "errors": ["node missing required fields"],
            },
        )

        client = BatchImportClient("http://localhost:8080")
        result = client.import_all(self._sample_nodes(2), [])

        assert result["errors"] == 1
