"""Simplified MCP client for OpenTrace agent.

Ported from insight-agent-2's SimpleMCPClient with:
- Static headers only (no TokenRefreshInterceptor)
- Async-only (no sync call path)
- Same lazy connect, retry, reconnect, and transport patterns
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Dict, Literal, Optional, Tuple

import httpx
from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client
from mcp.shared.exceptions import McpError
from mcp.types import CONNECTION_CLOSED

logger = logging.getLogger(__name__)

# The MCP library uses code 32600 (positive) for "Session terminated" when
# a POST to a dead/restarted server returns 404.
_SESSION_TERMINATED = 32600


class MCPToolError(Exception):
    """Raised when an MCP tool returns an error (isError=True)."""

    def __init__(self, tool_name: str, message: str):
        self.tool_name = tool_name
        self.message = message
        super().__init__(f"MCP tool '{tool_name}' error: {message}")


class MCPConnectionError(Exception):
    """Raised when MCP connection fails after all retries are exhausted."""

    def __init__(self, message: str, original_error: Exception | None = None):
        self.original_error = original_error
        super().__init__(message)


def is_connection_error(error: Exception) -> bool:
    """Determine if an exception represents a connection-level failure."""
    import anyio

    if isinstance(error, MCPToolError):
        return False
    if isinstance(error, McpError):
        return error.error.code in (CONNECTION_CLOSED, _SESSION_TERMINATED)
    if isinstance(
        error,
        (
            anyio.ClosedResourceError,
            anyio.BrokenResourceError,
            anyio.EndOfStream,
            httpx.NetworkError,
            httpx.TimeoutException,
            asyncio.TimeoutError,
            OSError,
        ),
    ):
        return True
    return False


class SimpleMCPClient:
    """Async MCP client with lazy connection and explicit close().

    The connection is established lazily on the first tool call (or explicit
    ``connect()``), and torn down via ``close()``.

    Example::

        client = SimpleMCPClient("https://mcp.example.com/sse")
        result = await client.save_node(name="foo")
        await client.close()
    """

    def __init__(
        self,
        url: str,
        transport: Literal["sse", "streamable_http"] = "sse",
        headers: Optional[Dict[str, str]] = None,
        max_retries: int = 3,
        initial_backoff_seconds: float = 1.0,
        call_tool_timeout: float = 120.0,
    ):
        self.url = url
        self.transport = transport
        self._headers = headers

        self._max_retries = max_retries
        self._initial_backoff_seconds = initial_backoff_seconds
        self._call_tool_timeout = call_tool_timeout

        # Connection state
        self._connected: bool = False
        self._connect_lock: asyncio.Lock = asyncio.Lock()
        self._tools: Dict[str, Dict[str, Any]] = {}
        self._session: Optional[ClientSession] = None
        self._session_context: Optional[ClientSession] = None
        self._session_version: int = 0
        self._reconnect_lock: asyncio.Lock = asyncio.Lock()
        self._transport_task: Optional[asyncio.Task] = None  # type: ignore[type-arg]

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def _ensure_connected(self) -> None:
        if self._connected:
            return
        async with self._connect_lock:
            if self._connected:
                return
            await self.connect()

    async def connect(self) -> None:
        """Establish the MCP connection, create a session, and discover tools."""
        read, write = await self._start_transport()

        try:
            self._session_context = ClientSession(read, write)
            self._session = await self._session_context.__aenter__()
            if not self._session:
                raise RuntimeError("Failed to create MCP session")
            await self._session.initialize()

            tools_result = await self._session.list_tools()
            for tool in tools_result.tools:
                self._tools[tool.name] = {
                    "description": tool.description,
                    "schema": tool.inputSchema,
                }

            self._connected = True
        except BaseException:
            await self.close()
            raise

    async def close(self) -> None:
        """Tear down the session and transport. Safe to call multiple times."""
        if not self._connected and self._session_context is None and self._transport_task is None:
            return

        try:
            if self._session_context is not None:
                await self._session_context.__aexit__(None, None, None)
        except BaseException as e:
            logger.exception("Error closing session: %s", e)
        finally:
            self._session_context = None
            self._session = None

        try:
            await self._stop_transport()
        except BaseException as e:
            logger.exception("Error closing transport: %s", e)

        self._connected = False
        self._tools = {}

    # ------------------------------------------------------------------
    # Tool dispatch
    # ------------------------------------------------------------------

    async def list_tools(self) -> Dict[str, Any]:
        await self._ensure_connected()
        return self._tools

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'")
        return self._create_tool_function(name)

    def _create_tool_function(self, tool_name: str) -> Callable[..., Any]:
        async def tool_function(**kwargs: Any) -> Any:
            await self._ensure_connected()

            if tool_name not in self._tools:
                available = list(self._tools.keys())
                raise AttributeError(f"Tool '{tool_name}' not found. Available tools: {available}")

            for attempt in range(self._max_retries + 1):
                version_before_call = self._session_version
                try:
                    if not self._session:
                        raise MCPConnectionError(f"MCP session to {self.url} is not initialized")
                    result = await asyncio.wait_for(
                        self._session.call_tool(tool_name, kwargs),
                        timeout=self._call_tool_timeout,
                    )
                    return self._extract_tool_result(tool_name, result)
                except MCPToolError:
                    raise
                except asyncio.TimeoutError as e:
                    if attempt >= self._max_retries:
                        raise MCPConnectionError(
                            f"MCP connection to {self.url} failed after "
                            f"{self._max_retries} retries while calling '{tool_name}'",
                            original_error=e,
                        ) from e
                    backoff = min(self._initial_backoff_seconds * (2**attempt), 30.0)
                    logger.warning(
                        "Timeout calling '%s' (attempt %d/%d), retrying in %.1fs: %s",
                        tool_name,
                        attempt + 1,
                        self._max_retries,
                        backoff,
                        e,
                    )
                    await asyncio.sleep(backoff)
                    await self._reconnect(version_before_call)
                except Exception as e:
                    if not is_connection_error(e):
                        raise
                    if attempt >= self._max_retries:
                        raise MCPConnectionError(
                            f"MCP connection to {self.url} failed after "
                            f"{self._max_retries} retries while calling '{tool_name}'",
                            original_error=e,
                        ) from e
                    backoff = min(self._initial_backoff_seconds * (2**attempt), 30.0)
                    logger.warning(
                        "Connection error calling '%s' (attempt %d/%d), retrying in %.1fs: %s",
                        tool_name,
                        attempt + 1,
                        self._max_retries,
                        backoff,
                        e,
                    )
                    await asyncio.sleep(backoff)
                    await self._reconnect(version_before_call)

        tool_function.__name__ = tool_name
        return tool_function

    # ------------------------------------------------------------------
    # Reconnect (version-gated)
    # ------------------------------------------------------------------

    async def _reconnect(self, expected_version: int) -> bool:
        async with self._reconnect_lock:
            if self._session_version > expected_version:
                return True

            logger.info(
                "Reconnecting SimpleMCPClient to %s (version %d)",
                self.url,
                self._session_version,
            )

            try:
                if self._session_context is not None:
                    await self._session_context.__aexit__(None, None, None)
            except BaseException as e:
                logger.debug("Error closing old session during reconnect: %s", e)
            self._session = None
            self._session_context = None

            try:
                await self._stop_transport()
            except BaseException as e:
                logger.debug("Error stopping old transport during reconnect: %s", e)

            try:
                read, write = await self._start_transport()

                self._session_context = ClientSession(read, write)
                self._session = await self._session_context.__aenter__()
                if not self._session:
                    raise RuntimeError("Failed to create session")
                await self._session.initialize()

                self._tools = {}
                tools_result = await self._session.list_tools()
                for tool in tools_result.tools:
                    self._tools[tool.name] = {
                        "description": tool.description,
                        "schema": tool.inputSchema,
                    }

                self._session_version += 1
                self._connected = True
                logger.info(
                    "SimpleMCPClient reconnected to %s (version %d)",
                    self.url,
                    self._session_version,
                )
                return True
            except Exception as e:
                logger.error("Failed to reconnect SimpleMCPClient to %s: %s", self.url, e)
                await self.close()
                return False

    # ------------------------------------------------------------------
    # Transport helpers
    # ------------------------------------------------------------------

    async def _start_transport(self) -> Tuple[Any, Any]:
        ready: asyncio.Future[Tuple[Any, Any]] = asyncio.get_running_loop().create_future()

        async def _transport_runner() -> None:
            http_client: Optional[httpx.AsyncClient] = None
            try:
                if self.transport == "sse":
                    transport_cm = sse_client(self.url, self._headers)
                elif self.transport == "streamable_http":
                    http_client = create_mcp_http_client(headers=self._headers)
                    transport_cm = streamable_http_client(self.url, http_client=http_client)
                else:
                    raise ValueError(f"Unsupported transport: {self.transport}")

                async with transport_cm as transport_result:
                    if self.transport == "sse":
                        read, write = transport_result
                    else:
                        read, write, _ = transport_result

                    if not ready.done():
                        ready.set_result((read, write))

                    await asyncio.Event().wait()
            except BaseException as exc:
                if not ready.done():
                    ready.set_exception(exc)
                else:
                    logger.warning("Transport task ended: %s", exc)
            finally:
                if http_client:
                    try:
                        await http_client.aclose()
                    except Exception:
                        pass

        self._transport_task = asyncio.create_task(_transport_runner())
        try:
            return await ready
        except BaseException:
            if self._transport_task and not self._transport_task.done():
                self._transport_task.cancel()
                try:
                    await self._transport_task
                except BaseException:
                    pass
            self._transport_task = None
            raise

    async def _stop_transport(self) -> None:
        task = self._transport_task
        self._transport_task = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except BaseException:
                pass

    # ------------------------------------------------------------------
    # Result extraction
    # ------------------------------------------------------------------

    def _extract_tool_result(self, tool_name: str, result: Any) -> str:
        if result.isError:
            error_text = result.content[0].text if result.content else "Unknown MCP error"
            raise MCPToolError(tool_name, error_text)

        if result.content:
            return str(result.content[0].text)
        else:
            logger.warning(
                "MCP tool '%s' returned empty content (isError=%s)",
                tool_name,
                result.isError,
            )
            return ""
