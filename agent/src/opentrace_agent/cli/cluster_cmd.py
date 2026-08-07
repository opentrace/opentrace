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

"""``opentraceai cluster`` — run community detection over the stored graph.

Wraps :func:`opentrace_agent.pipeline.cluster.run_clustering`. Idempotent: clears
existing Community nodes + memberships before writing fresh ones, so re-running
on the same DB produces the same shape (deterministic seed).
"""

from __future__ import annotations

import json
from dataclasses import asdict

import click


def run_cluster_cli(db_path: str, output_json: bool = False) -> None:
    """Open the store, run clustering, print a summary."""
    try:
        from opentrace_agent.pipeline.cluster import run_clustering
    except RuntimeError as exc:
        # Missing networkx/graspologic — surface the actionable hint.
        raise click.ClickException(str(exc)) from exc

    from opentrace_agent.store import GraphStore

    with GraphStore(db_path) as store:
        report = run_clustering(store)

    if output_json:
        click.echo(json.dumps(asdict(report), indent=2))
        return

    if report.nodes == 0:
        click.echo("No nodes to cluster — index a codebase first.")
        return

    click.echo(
        f"Clustered {report.nodes} nodes / {report.edges} edges "
        f"into {report.communities} communities "
        f"({report.god_communities} flagged as god, "
        f"largest = {report.largest_community} nodes, "
        f"mean cohesion = {report.mean_cohesion:.2f})."
    )
