"""gRPC AgentService implementation — runs the agent pipeline and streams progress."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, AsyncIterator
from urllib.parse import urlparse

from opentrace_agent.gen.opentrace.v1 import agent_service_pb2 as pb2
from opentrace_agent.gen.opentrace.v1 import agent_service_pb2_grpc as pb2_grpc
from opentrace_agent.gen.opentrace.v1 import job_config_pb2

if TYPE_CHECKING:
    from opentrace_agent.container import AppContainer

logger = logging.getLogger(__name__)


def _git_integrations_to_sources_config(
    integrations: list[job_config_pb2.GitIntegrationConfig],
) -> dict[str, Any]:
    """Translate proto GitIntegrationConfig list into the sources_config dict
    expected by the Source/Loader pipeline.

    Each integration's repo_url is parsed to extract owner/name. The result
    is structured as ``{"code": {"github": {"repos": [...]}}}``.
    """
    if not integrations:
        return {}

    repos: list[dict[str, Any]] = []
    for integration in integrations:
        parsed = urlparse(integration.repo_url)
        path_parts = parsed.path.strip("/").split("/")
        if len(path_parts) < 2:
            logger.warning(
                "Cannot parse owner/name from repo_url '%s', skipping",
                integration.repo_url,
            )
            continue

        owner = path_parts[0]
        name = path_parts[1]
        # Strip .git suffix if present
        if name.endswith(".git"):
            name = name[:-4]

        repo: dict[str, Any] = {
            "owner": owner,
            "name": name,
        }
        if integration.ref:
            repo["branch"] = integration.ref
        if integration.personal_access_token:
            repo["token"] = integration.personal_access_token

        repos.append(repo)

    if not repos:
        return {}

    return {"code": {"github": {"repos": repos}}}


class AgentServiceServicer(pb2_grpc.AgentServiceServicer):
    """Streams pipeline progress as RunJobEvent messages."""

    def __init__(self, container: AppContainer) -> None:
        self._container = container

    async def RunJob(
        self,
        request: pb2.RunJobRequest,
        context: Any,
    ) -> AsyncIterator[pb2.RunJobEvent]:
        all_errors: list[str] = []
        total_nodes = 0
        total_rels = 0
        repos_processed = 0

        # Determine whether to use MCP (legacy) or stream mapper (new).
        use_mcp = bool(request.mcp_url)

        try:
            # --- STARTING ---
            if use_mcp:
                yield pb2.RunJobEvent(
                    phase=pb2.JOB_PHASE_STARTING,
                    message="Initialising registry and MCP client",
                )
            else:
                yield pb2.RunJobEvent(
                    phase=pb2.JOB_PHASE_STARTING,
                    message="Initialising registry (streaming mode)",
                )

            registry = self._container.source_registry()

            # --- PLANNING ---
            sources_config = _git_integrations_to_sources_config(
                list(request.git_integrations),
            )
            sources_to_run: list[str] = []

            for source_type, source in registry.all_sources.items():
                source_cfg = sources_config.get(source_type, {})
                has_config = any(loader.provider_name in source_cfg for loader in source.loaders)
                if has_config:
                    sources_to_run.append(source_type)

            if not sources_to_run:
                yield pb2.RunJobEvent(
                    phase=pb2.JOB_PHASE_ERROR,
                    message="No sources to run after planning",
                    errors=["No configured integrations produced runnable sources"],
                )
                return

            yield pb2.RunJobEvent(
                phase=pb2.JOB_PHASE_PLANNING,
                message=f"Will run {len(sources_to_run)} source(s): {', '.join(sources_to_run)}",
            )

            # --- LOADING ---
            from opentrace_agent.models.base import TreeWithOrigin

            all_trees: list[TreeWithOrigin] = []

            for source_type in sources_to_run:
                source = registry.get(source_type)
                if not source:
                    all_errors.append(f"Source '{source_type}' not found in registry")
                    continue

                source_cfg = sources_config.get(source_type, {})
                try:
                    trees = await source.collect(source_cfg)
                    all_trees.extend(trees)
                    for tree in trees:
                        repos_processed += 1
                        yield pb2.RunJobEvent(
                            phase=pb2.JOB_PHASE_LOADING,
                            message=f"Loaded tree from '{tree.origin}'",
                            repo_url=getattr(tree.root, "url", ""),
                        )
                except Exception as e:
                    msg = f"Error loading source '{source_type}': {e}"
                    logger.error(msg)
                    all_errors.append(msg)

            if not all_trees:
                yield pb2.RunJobEvent(
                    phase=pb2.JOB_PHASE_ERROR,
                    message="No trees produced by any source",
                    errors=all_errors or ["All sources returned empty results"],
                )
                return

            # --- MAPPING ---
            yield pb2.RunJobEvent(
                phase=pb2.JOB_PHASE_MAPPING,
                message=f"Mapping {len(all_trees)} tree(s) to graph",
            )

            if use_mcp:
                # Legacy path: save via MCP client.
                headers: dict[str, str] = {}
                if request.api_key:
                    headers["Authorization"] = f"Bearer {request.api_key}"

                mcp_client = self._container.mcp_client(
                    url=request.mcp_url,
                    headers=headers if headers else None,
                )
                try:
                    mapper = self._container.graph_mapper(mcp=mcp_client)
                    mapping_result = await mapper.map_trees(all_trees)
                    total_nodes = mapping_result.nodes_created
                    total_rels = mapping_result.relationships_created
                    all_errors.extend(mapping_result.errors)
                finally:
                    await mcp_client.close()
            else:
                # New path: stream nodes/rels back via gRPC events.
                from opentrace_agent.graph.stream_mapper import stream_trees

                for event in stream_trees(all_trees):
                    total_nodes += len(event.nodes)
                    total_rels += len(event.relationships)
                    yield event

            # --- DONE ---
            yield pb2.RunJobEvent(
                phase=pb2.JOB_PHASE_DONE,
                message="Job completed",
                result=pb2.JobResult(
                    nodes_created=total_nodes,
                    relationships_created=total_rels,
                    repos_processed=repos_processed,
                ),
                errors=all_errors,
            )

        except Exception as e:
            msg = f"Unexpected error: {e}"
            logger.exception(msg)
            all_errors.append(msg)
            yield pb2.RunJobEvent(
                phase=pb2.JOB_PHASE_ERROR,
                message=msg,
                errors=all_errors,
            )
