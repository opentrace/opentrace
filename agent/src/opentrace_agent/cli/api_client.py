"""REST client for the OpenTrace batch import API."""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

import httpx

logger = logging.getLogger(__name__)

# Retry settings
_MAX_RETRIES = 3
_BACKOFF_BASE = 1.0  # seconds


class ImportError(Exception):
    """Raised when the API returns an unrecoverable error."""


class BatchImportClient:
    """Uploads nodes and relationships to the OpenTrace API.

    Usage::

        client = BatchImportClient("http://localhost:8080")
        client.check_connectivity()
        result = client.import_all(nodes, rels, batch_size=200)
    """

    def __init__(self, base_url: str, timeout: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    def check_connectivity(self) -> dict[str, Any]:
        """GET /api/v1/graph/stats as a health check.

        Returns:
            The stats response dict.

        Raises:
            ConnectionError: If the server is unreachable.
        """
        url = f"{self._base_url}/api/v1/graph/stats"
        try:
            resp = httpx.get(url, timeout=self._timeout)
            resp.raise_for_status()
            return resp.json()
        except httpx.ConnectError as exc:
            raise ConnectionError(
                f"Cannot connect to OpenTrace API at {self._base_url}. "
                "Is the server running?"
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise ConnectionError(
                f"OpenTrace API returned {exc.response.status_code} on health check"
            ) from exc

    def import_all(
        self,
        nodes: list[dict[str, Any]],
        relationships: list[dict[str, Any]],
        batch_size: int = 200,
        on_progress: Callable[[str], None] | None = None,
    ) -> dict[str, int]:
        """Upload nodes then relationships in batches.

        Args:
            nodes: List of node dicts (id, type, name, properties).
            relationships: List of relationship dicts.
            batch_size: Max items per API call.
            on_progress: Optional callback for progress messages.

        Returns:
            Summary dict with ``nodes_created`` and ``relationships_created``.
        """
        total_nodes = 0
        total_rels = 0
        all_errors: list[str] = []

        # Phase 1: Upload nodes
        for i in range(0, max(len(nodes), 1), batch_size):
            batch = nodes[i : i + batch_size]
            if not batch:
                break
            if on_progress:
                on_progress(f"Uploading nodes {i + 1}-{i + len(batch)} of {len(nodes)}")
            result = self._post_batch(batch, [])
            total_nodes += result.get("nodes_created", 0)
            all_errors.extend(result.get("errors", []))

        # Phase 2: Upload relationships
        for i in range(0, max(len(relationships), 1), batch_size):
            batch = relationships[i : i + batch_size]
            if not batch:
                break
            if on_progress:
                on_progress(
                    f"Uploading relationships {i + 1}-{i + len(batch)} of {len(relationships)}"
                )
            result = self._post_batch([], batch)
            total_rels += result.get("relationships_created", 0)
            all_errors.extend(result.get("errors", []))

        if all_errors:
            logger.warning("Import completed with %d errors", len(all_errors))
            for err in all_errors[:5]:
                logger.warning("  %s", err)
            if len(all_errors) > 5:
                logger.warning("  ... and %d more", len(all_errors) - 5)

        return {
            "nodes_created": total_nodes,
            "relationships_created": total_rels,
            "errors": len(all_errors),
        }

    def _post_batch(
        self,
        nodes: list[dict[str, Any]],
        relationships: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """POST a single batch to /api/v1/graph/import with retry."""
        url = f"{self._base_url}/api/v1/graph/import"
        payload = {"nodes": nodes, "relationships": relationships}

        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES):
            try:
                resp = httpx.post(url, json=payload, timeout=self._timeout)
                # Fail fast on client errors (bad data won't get better)
                if 400 <= resp.status_code < 500:
                    raise ImportError(f"API returned {resp.status_code}: {resp.text}")
                resp.raise_for_status()
                return resp.json()
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES - 1:
                    wait = _BACKOFF_BASE * (2**attempt)
                    logger.warning(
                        "Retry %d/%d after %.1fs: %s",
                        attempt + 1,
                        _MAX_RETRIES,
                        wait,
                        exc,
                    )
                    time.sleep(wait)
            except httpx.HTTPStatusError as exc:
                # 5xx — retry
                last_exc = exc
                if attempt < _MAX_RETRIES - 1:
                    wait = _BACKOFF_BASE * (2**attempt)
                    logger.warning(
                        "Retry %d/%d after %.1fs: server returned %d",
                        attempt + 1,
                        _MAX_RETRIES,
                        wait,
                        exc.response.status_code,
                    )
                    time.sleep(wait)

        raise ConnectionError(
            f"Failed to upload batch after {_MAX_RETRIES} attempts: {last_exc}"
        )
