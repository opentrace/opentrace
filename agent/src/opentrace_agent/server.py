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

"""gRPC server entrypoint for the OpenTrace agent."""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal

import grpc.aio

from opentrace_agent.config import load_config
from opentrace_agent.container import AppContainer
from opentrace_agent.gen.opentrace.v1 import agent_service_pb2_grpc
from opentrace_agent.service import AgentServiceServicer

logger = logging.getLogger(__name__)


async def serve(port: int, container: AppContainer) -> None:
    """Start the gRPC server and block until a shutdown signal is received."""
    server = grpc.aio.server()
    agent_service_pb2_grpc.add_AgentServiceServicer_to_server(AgentServiceServicer(container), server)
    listen_addr = f"[::]:{port}"
    server.add_insecure_port(listen_addr)

    await server.start()
    logger.info("Agent gRPC server listening on %s", listen_addr)

    # Graceful shutdown on SIGINT / SIGTERM
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _signal_handler() -> None:
        logger.info("Shutdown signal received, stopping server…")
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    await stop_event.wait()
    await server.stop(grace=5)
    logger.info("Server stopped")


def main() -> None:
    """CLI entrypoint: parse --config flag, load shared config, start server."""
    parser = argparse.ArgumentParser(description="OpenTrace Agent gRPC server")
    parser.add_argument(
        "--config",
        default="",
        metavar="PATH",
        help="Path to config.yaml (shared with the Go API)",
    )
    args = parser.parse_args()

    cfg = load_config(args.config)

    logging.basicConfig(
        level=getattr(logging, cfg.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    container = AppContainer(config=cfg)
    asyncio.run(serve(cfg.port, container))


if __name__ == "__main__":
    main()
