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

"""``opentraceai analyze`` — report the graph's hotspots: god nodes, cross-community bridges, starter questions.

Reads from the store via :meth:`GraphStore.list_god_nodes` and
:meth:`GraphStore.list_cross_community_bridges`. The "questions" tab is a
placeholder until the LLM extraction stage is wired up — it returns
template starter questions seeded by the top god nodes.
"""

from __future__ import annotations

import json
from typing import Any

import click


def _suggested_questions(gods: list[dict[str, Any]], bridges: list[dict[str, Any]]) -> list[str]:
    """Deterministic placeholder until LLM extraction is wired up.

    Seeds prompts off the top god nodes and the most prominent cross-community
    bridges. Stable across runs of the same graph, so the CLI is reproducible
    in tests and snapshots.
    """
    out: list[str] = []
    for g in gods[:5]:
        out.append(f"What depends on {g['name']}?")
    for b in bridges[:3]:
        out.append(
            f"What links {b['source_name']} (in {b['source_community_name']}) "
            f"with {b['target_name']} (in {b['target_community_name']})?"
        )
    return out


def run_analyze_cli(
    db_path: str,
    *,
    god_limit: int = 10,
    bridge_limit: int = 10,
    output_json: bool = False,
) -> None:
    from opentrace_agent.retrieval import (
        cross_community_bridges,
        cross_domain_bridges,
        find_communities_spanning_domains,
        god_nodes,
    )
    from opentrace_agent.store import GraphStore

    with GraphStore(db_path) as store:
        gods = god_nodes(store, limit=god_limit)
        bridges = cross_community_bridges(store, limit=bridge_limit)
        # Phase 7: cross-domain (code/page) connectivity.
        domain_bridges = cross_domain_bridges(store, limit=bridge_limit)
        cross_cutting = find_communities_spanning_domains(store, min_domains=2, limit=bridge_limit)

    questions = _suggested_questions(gods, bridges)

    if output_json:
        click.echo(
            json.dumps(
                {
                    "gods": gods,
                    "bridges": bridges,
                    "cross_domain_bridges": domain_bridges,
                    "cross_cutting_communities": cross_cutting,
                    "questions": questions,
                },
                indent=2,
            )
        )
        return

    click.echo(f"God nodes (top {len(gods)} by degree):")
    if not gods:
        click.echo("  (none — index and cluster a codebase first)")
    for g in gods:
        click.echo(f"  {g['degree']:>4}  {g['type']:<14}  {g['name']}")

    click.echo("")
    click.echo(f"Cross-community bridges ({len(bridges)}):")
    if not bridges:
        click.echo("  (none — run `opentraceai cluster` to assign communities)")
    for b in bridges:
        click.echo(
            f"  {b['source_name']} [{b['source_community_name']}] "
            f"--{b['relation']}--> "
            f"{b['target_name']} [{b['target_community_name']}]"
        )

    click.echo("")
    click.echo(f"Cross-domain bridges (code ↔ page) ({len(domain_bridges)}):")
    if not domain_bridges:
        click.echo("  (none — run `index --wiki` to populate multiple domains)")
    for b in domain_bridges:
        click.echo(
            f"  {b['source_name']} ({b['source_domain']}/{b['source_type']}) "
            f"--{b['edge_type']}--> "
            f"{b['target_name']} ({b['target_domain']}/{b['target_type']})"
        )

    if cross_cutting:
        click.echo("")
        click.echo(f"Cross-cutting communities (span ≥2 domains) ({len(cross_cutting)}):")
        for c in cross_cutting:
            domain_str = "+".join(c["domains"])
            click.echo(f"  {c['name']} — {domain_str} ({c['total_members']} members: {c['member_counts']})")

    click.echo("")
    click.echo("Suggested questions:")
    for q in questions:
        click.echo(f"  - {q}")
