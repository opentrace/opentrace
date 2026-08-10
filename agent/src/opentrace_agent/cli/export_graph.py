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

"""``opentraceai export-graph`` — exporters for the knowledge graph.

Three formats:

* ``graphml``  — universal escape hatch (Gephi, yEd, Cytoscape).
* ``obsidian`` — markdown vault (one note per node, wikilinks for edges).
* ``report``   — a folder of linked markdown pages: an ``index.md`` dashboard
                 (provenance, Mermaid community map), per-community and
                 per-god-node pages, and a ``bridges.md`` of community- and
                 domain-crossing edges.

Each subcommand reads from the store and writes to an output path. No LLM
calls at export time — exporters are pure functions of the stored graph.

**Keep module-level imports to stdlib and click.** ``main.py`` imports this
module eagerly to register the command group (a Click group has to exist
before the CLI dispatches), so anything imported at module scope here is paid
by every ``opentraceai`` invocation, including ``--help``. networkx and the
store are therefore imported inside the command bodies, not here.
"""

from __future__ import annotations

import logging
from pathlib import Path

import click

logger = logging.getLogger(__name__)


@click.group("export-graph")
def export_graph_app() -> None:
    """Export the knowledge graph to a portable format."""


def _build_export_graph(store):  # type: ignore[no-untyped-def]
    """Build a networkx DiGraph for export. Excludes IndexMetadata.

    Community ids ride as a node attribute so Gephi/yEd can colour by
    community — the partition is metadata about nodes, so there is no
    community node to render and no membership edge to draw.
    """
    try:
        import networkx as nx
    except ImportError as exc:
        raise click.ClickException(
            "networkx not installed. It is a core dependency — reinstall opentraceai, "
            "or `uv pip install networkx` into the active environment."
        ) from exc

    from opentrace_agent.store.graph_store import GraphStore as _Store

    nodes, edges = store.iter_analysis_graph()
    g = nx.DiGraph()
    for n in nodes:
        # GraphML only accepts primitive attributes — strip None and collapse
        # missing fields to empty strings. An unassigned node gets -1 rather
        # than a missing key: GraphML keys are declared per-attribute, so an
        # absent value reads as community 0 in some importers.
        g.add_node(
            n["id"],
            type=n["type"] or "",
            name=n["name"] or "",
            community=int(n.get(_Store.COMMUNITY_PROPERTY, -1)),
        )
    for src, tgt in edges:
        if g.has_node(src) and g.has_node(tgt):
            g.add_edge(src, tgt)
    return g


@export_graph_app.command("graphml")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="OpenTrace database path (auto-detected if omitted).",
)
@click.option(
    "-o",
    "--output",
    required=True,
    type=click.Path(),
    help="Destination path for the .graphml file.",
)
def graphml_cmd(db_path: str | None, output: str) -> None:
    """Export the stored graph as GraphML (Gephi, yEd, Cytoscape).

    Each node carries a ``community`` attribute (-1 when unassigned) so those
    tools can colour by cluster without the partition existing as nodes of its
    own. IndexMetadata is excluded (it's a per-repo provenance record, not part
    of the graph).
    """
    import networkx as nx

    from opentrace_agent.cli.main import _resolve_db
    from opentrace_agent.store import GraphStore

    resolved = _resolve_db(db_path, must_exist=True)
    out_path = Path(output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with GraphStore(resolved) as store:
        g = _build_export_graph(store)

    nx.write_graphml(g, str(out_path))
    click.echo(f"Wrote {g.number_of_nodes()} nodes / {g.number_of_edges()} edges to {out_path}")


# ---------------------------------------------------------------------------
# Obsidian + wiki exporters share a community → members projection
# ---------------------------------------------------------------------------


def _slugify(s: str) -> str:
    """Filesystem-safe lowercase-kebab slug.

    Used for folder + file names in the Obsidian vault and wiki output.
    Collapses runs of non-alphanumeric characters into a single dash so
    "Foo / Bar (v2)" → "foo-bar-v2" rather than "foo---bar-v2".
    """
    out: list[str] = []
    prev_dash = False
    for ch in s.lower():
        if ch.isalnum() or ch == "_":
            out.append(ch)
            prev_dash = False
        else:
            if not prev_dash:
                out.append("-")
                prev_dash = True
    slug = "".join(out).strip("-")
    return slug or "node"


def _clean_name(name: str | None) -> str:
    """Collapse whitespace runs to a single space and strip.

    Tree-sitter sometimes captures a Function/Method ``name`` as its full
    multi-line declaration. Left raw, that name breaks YAML frontmatter
    (multi-line strings inside quotes are invalid), the H1 heading, and
    wiki-link targets (``[[...newline...]]`` is invalid in every
    wiki-link implementation).
    """
    if not name:
        return ""
    return " ".join(name.split())


def _display_name(node: dict) -> str:
    """A short, readable name for filenames + display text.

    Beyond whitespace cleanup, also strips function/method/class signature
    noise so ``def foo(*, a, b):`` renders as ``foo`` and ``class Bar(Base):``
    renders as ``Bar``. Other node types (Service, Cluster, etc.) pass through
    untouched — names like ``"GPT-4 (OpenAI)"`` are allowed to keep their
    parens because they're not signatures, they're real names.
    """
    name = _clean_name(node.get("name"))
    if not name:
        return node.get("id") or ""
    if node.get("type") in {"Function", "Method", "Class"}:
        # Drop the parameter list and anything after.
        if "(" in name:
            name = name.split("(", 1)[0].rstrip()
        # Drop a leading ``def `` / ``class `` keyword if tree-sitter
        # captured the whole declaration.
        for prefix in ("def ", "class ", "async def "):
            if name.startswith(prefix):
                name = name[len(prefix) :].lstrip()
                break
    return name or (node.get("id") or "")


def _project_graph(store):  # type: ignore[no-untyped-def]
    """Return ``(nodes_by_id, edges, communities, memberships)`` for exporters.

    - ``nodes_by_id``: id → ``{id, type, name}`` for non-internal source nodes.
    - ``edges``: list of ``(source_id, target_id, relation)`` between source nodes.
    - ``communities``: list of derived community summary dicts.
    - ``memberships``: community_id → list of node_ids.

    Membership rides along on the nodes ``iter_analysis_graph`` already
    returned, so grouping is a pass over them rather than a lookup per node.
    """
    from opentrace_agent.retrieval.communities import list_communities
    from opentrace_agent.store.graph_store import GraphStore as _Store

    nodes, edges = store.iter_analysis_graph()
    nodes_by_id = {n["id"]: n for n in nodes}

    communities = list_communities(store)
    memberships: dict[int, list[str]] = {c["id"]: [] for c in communities}
    for node_id, node in nodes_by_id.items():
        community = node.get(_Store.COMMUNITY_PROPERTY)
        if community is None:
            continue
        memberships.setdefault(int(community), []).append(node_id)

    # We want (s, t, relation) but iter_analysis_graph only returns (s, t).
    # Pull the relation type by re-querying — cheap because we only iterate
    # once. The default row cap (10k) silently truncates large graphs, so
    # derive the limit from the edge count we already know.
    rel_edges: list[tuple[str, str, str]] = []
    rel_rows = store.list_relationships_for_nodes(set(nodes_by_id), limit=max(10_000, 2 * len(edges)))
    for r in rel_rows:
        if r["source_id"] in nodes_by_id and r["target_id"] in nodes_by_id:
            rel_edges.append((r["source_id"], r["target_id"], r["type"]))

    return nodes_by_id, rel_edges, communities, memberships


def _node_filename(node: dict, used: set[str]) -> str:
    """Deterministic, collision-free filename for one node.

    The id suffix disambiguates the common case, but it is not itself unique:
    two ids sharing their last 8 slugified characters collide again. Every
    candidate is therefore checked against *used* and a counter appended until
    one is free — an unchecked second candidate would silently overwrite an
    already-written note and drop it from the vault.
    """
    base = _slugify(_display_name(node) or node["id"])
    candidate = f"{base}.md"
    if candidate not in used:
        used.add(candidate)
        return candidate

    # Collision: disambiguate with a short id suffix, then with a counter.
    suffix = _slugify(node["id"])[-8:]
    candidate = f"{base}--{suffix}.md"
    counter = 2
    while candidate in used:
        candidate = f"{base}--{suffix}-{counter}.md"
        counter += 1
    used.add(candidate)
    return candidate


@export_graph_app.command("obsidian")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="OpenTrace database path (auto-detected if omitted).",
)
@click.option(
    "-o",
    "--output",
    required=True,
    type=click.Path(),
    help="Destination directory (will be created if missing).",
)
def obsidian_cmd(
    db_path: str | None,
    output: str,
) -> None:
    """Export an Obsidian-compatible vault: one .md per node, folder per community.

    Synthesises a vault from the graph. One ``.md`` per node, folder per
    community, wikilinks for edges. Nodes without a community land in
    ``_uncategorised/``.
    """
    from pathlib import Path

    from opentrace_agent.cli.main import _resolve_db

    out_root = Path(output)
    out_root.mkdir(parents=True, exist_ok=True)

    from opentrace_agent.store import GraphStore

    resolved = _resolve_db(db_path, must_exist=True)

    with GraphStore(resolved) as store:
        nodes_by_id, edges, communities, memberships = _project_graph(store)

    # Build per-node edge lists for fast rendering.
    out_edges: dict[str, list[tuple[str, str]]] = {nid: [] for nid in nodes_by_id}
    for src, tgt, rel in edges:
        if src in out_edges and tgt in nodes_by_id:
            out_edges[src].append((rel, tgt))
        if tgt in out_edges and src in nodes_by_id:
            out_edges[tgt].append((f"<-{rel}", src))

    # Resolve community names (and the catch-all bucket for unassigned nodes).
    folder_for_community: dict[str, str] = {}
    used_folders: set[str] = set()
    for c in communities:
        slug = _slugify(c["name"])
        if slug in used_folders:
            slug = f"{slug}--{c.get('community_id', '?')}"
        used_folders.add(slug)
        folder_for_community[c["id"]] = slug
        (out_root / slug).mkdir(parents=True, exist_ok=True)
    uncategorised = "_uncategorised"
    (out_root / uncategorised).mkdir(parents=True, exist_ok=True)

    used_filenames: set[str] = set()
    node_path: dict[str, str] = {}
    node_link_target: dict[str, str] = {}
    for nid, node in nodes_by_id.items():
        # Find the community this node belongs to (if any).
        folder = uncategorised
        for cid, members in memberships.items():
            if nid in members and cid in folder_for_community:
                folder = folder_for_community[cid]
                break
        fname = _node_filename(node, used_filenames)
        node_path[nid] = f"{folder}/{fname}"
        # Wiki-link target is the filename without ``.md`` — Obsidian and
        # most other readers resolve ``[[foo]]`` to ``foo.md`` regardless
        # of folder, so this is sufficient and avoids hardcoding paths
        # that break when the user reorganises the vault.
        node_link_target[nid] = fname.removesuffix(".md")

    # Write the files.
    for nid, node in nodes_by_id.items():
        rel_path = node_path[nid]
        path = out_root / rel_path
        display = _display_name(node) or nid
        # YAML frontmatter ``name`` is quoted; escape any embedded double
        # quotes so the parser doesn't choke on identifiers like
        # ``Class "Foo"``. Newlines were already collapsed by _clean_name.
        yaml_name = display.replace('"', '\\"')
        lines = ["---", f'id: "{nid}"', f"type: {node['type']}", f'name: "{yaml_name}"', "---", ""]
        lines.append(f"# {display}")
        lines.append("")
        lines.append(f"**Type**: {node['type']}")
        lines.append("")
        if out_edges.get(nid):
            lines.append("## Edges")
            for rel, other in out_edges[nid]:
                other_node = nodes_by_id[other]
                other_display = _display_name(other_node) or other
                target = node_link_target[other]
                # Alias syntax: link target = actual filename slug,
                # visible text = readable name. Matches the syntax used
                # by the wiki vault's WikiMarkdown component.
                if target == _slugify(other_display):
                    lines.append(f"- {rel} → [[{target}]]")
                else:
                    lines.append(f"- {rel} → [[{target}|{other_display}]]")
            lines.append("")
        path.write_text("\n".join(lines))

    click.echo(f"Wrote {len(nodes_by_id)} notes across {len(folder_for_community)} community folders to {out_root}")


@export_graph_app.command("report")
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="OpenTrace database path (auto-detected if omitted).",
)
@click.option(
    "-o",
    "--output",
    required=True,
    type=click.Path(),
    help="Destination directory (will be created if missing).",
)
def report_cmd(db_path: str | None, output: str) -> None:
    """Write the graph out as a folder of linked markdown pages.

    ``index.md`` is the entry point — provenance header, a Mermaid map of the
    community structure, and links into the rest. Every community gets a page
    under ``communities/``, every god node a page under ``gods/``, and
    ``bridges.md`` collects the edges that cross community or domain
    boundaries. Deterministic projection of stored data — no LLM calls at
    export time.
    """
    from collections import defaultdict
    from pathlib import Path

    from opentrace_agent.cli.main import _resolve_db
    from opentrace_agent.retrieval import (
        cross_community_bridges,
        cross_domain_bridges,
        find_communities_spanning_domains,
    )
    from opentrace_agent.store import GraphStore

    list_cap = 25  # longest member/edge list any single page renders
    map_cap = 30  # most communities the Mermaid map will draw

    resolved = _resolve_db(db_path, must_exist=True)
    out_root = Path(output)
    out_root.mkdir(parents=True, exist_ok=True)

    with GraphStore(resolved) as store:
        nodes_by_id, edges, communities, memberships = _project_graph(store)
        god_nodes = store.list_god_nodes(limit=20)
        metadata = store.get_metadata()
        # Retrieval-layer helper, not the raw store call: community labels are
        # derived, so only this wrapper joins them onto the bridge rows.
        community_bridges = cross_community_bridges(store, limit=list_cap)
        domain_bridges = cross_domain_bridges(store, limit=list_cap)
        cross_cutting = find_communities_spanning_domains(store, min_domains=2, limit=list_cap)

    # Per-node outgoing adjacency, used for degree ranking and page rendering.
    out_edges: dict[str, list[tuple[str, str]]] = {nid: [] for nid in nodes_by_id}
    for src, tgt, rel in edges:
        if src in out_edges and tgt in nodes_by_id:
            out_edges[src].append((rel, tgt))

    # Reverse membership map: node id → its community record.
    community_of: dict[str, dict] = {}
    for c in communities:
        for member_id in memberships.get(c["id"], []):
            community_of[member_id] = c

    # Assign collision-free slugs for both page sets up front.
    community_slug: dict[str, str] = {}
    taken: set[str] = set()
    for c in communities:
        slug = _slugify(c["name"])
        if slug in taken:
            slug = f"{slug}--{c.get('community_id', '?')}"
        taken.add(slug)
        community_slug[c["id"]] = slug

    god_slug: dict[str, str] = {}
    taken.clear()
    for g in god_nodes:
        slug = _slugify(g["name"])
        if slug in taken:
            slug = f"{slug}--{_slugify(g['id'])[-8:]}"
        taken.add(slug)
        god_slug[g["id"]] = slug

    community_by_id = {c["id"]: c for c in communities}

    # ---- index.md ------------------------------------------------------
    index = [
        "# Knowledge Graph",
        "",
        f"This graph holds {len(nodes_by_id)} nodes connected by {len(edges)} edges. "
        f"Community detection grouped them into {len(communities)} communities, and "
        f"{len(god_nodes)} highly connected nodes are broken out below.",
    ]
    for meta in sorted(metadata, key=lambda m: str(m.get("indexedAt") or "")):
        origin = meta.get("repoId") or meta.get("repoPath") or "unknown source"
        commit = str(meta.get("commitSha") or "")
        branch = str(meta.get("branch") or "")
        detail = f" @ {commit[:8]}" if commit else ""
        if branch:
            detail += f" ({branch})"
        index += [
            "",
            f"Indexed from `{origin}`{detail} on {meta.get('indexedAt', '?')} "
            f"— opentraceai {meta.get('opentraceaiVersion', '?')}.",
        ]

    if communities:
        mapped = sorted(communities, key=lambda c: len(memberships.get(c["id"], [])), reverse=True)[:map_cap]
        mapped_ids = {c["id"] for c in mapped}
        pair_counts: dict[tuple[str, str], int] = {}
        for src, tgt, _rel in edges:
            sc, tc = community_of.get(src), community_of.get(tgt)
            if not sc or not tc or sc["id"] == tc["id"]:
                continue
            if sc["id"] in mapped_ids and tc["id"] in mapped_ids:
                key = tuple(sorted((sc["id"], tc["id"])))
                pair_counts[key] = pair_counts.get(key, 0) + 1
        index += ["", "## Map", "", "```mermaid", "graph LR"]
        for c in mapped:
            safe_name = str(c["name"]).replace('"', "'")
            index.append(f'  c{c["community_id"]}["{safe_name} ({len(memberships.get(c["id"], []))})"]')
        for (id_a, id_b), count in sorted(pair_counts.items()):
            index.append(
                f"  c{community_by_id[id_a]['community_id']} ---|{count}| c{community_by_id[id_b]['community_id']}"
            )
        index.append("```")
        if len(communities) > map_cap:
            index.append(f"_Showing the {map_cap} largest of {len(communities)} communities._")

    index += ["", "## God Nodes"]
    index.extend(
        f"- [{g['name']}](gods/{god_slug[g['id']]}.md): a {g['type']} touching {g['degree']} edges" for g in god_nodes
    )
    index += ["", "## Communities"]
    index.extend(
        f"- [{c['name']}](communities/{community_slug[c['id']]}.md): "
        f"{len(memberships.get(c['id'], []))} members, {c.get('cohesion', 0.0):.2f} cohesion"
        for c in communities
    )
    index += ["", "See also: [Bridges](bridges.md) — edges that cross community and domain boundaries."]
    (out_root / "index.md").write_text("\n".join(index))

    # ---- bridges.md ------------------------------------------------------
    bridge_page = [
        "# Bridges",
        "",
        "Edges whose endpoints live in different communities or different domains — "
        "the seams where one area of the system touches another.",
        "",
        "## Cross-community",
    ]
    if community_bridges:
        bridge_page.extend(
            f"- {b['source_name']} [{b['source_community_name']}] "
            f"--{b['relation']}--> {b['target_name']} [{b['target_community_name']}]"
            for b in community_bridges
        )
    else:
        bridge_page.append("(none — run `opentraceai cluster` to assign communities)")
    bridge_page += ["", "## Cross-domain (code ↔ doc)"]
    if domain_bridges:
        bridge_page.extend(
            f"- {b['source_name']} ({b['source_domain']}/{b['source_type']}) "
            f"--{b['edge_type']}--> {b['target_name']} ({b['target_domain']}/{b['target_type']})"
            for b in domain_bridges
        )
    else:
        bridge_page.append("(none — every edge stays inside a single domain)")
    bridge_page += ["", "## Communities spanning multiple domains"]
    if cross_cutting:
        bridge_page.extend(
            f"- {c['name']} — {'+'.join(c['domains'])}, {c['total_members']} members" for c in cross_cutting
        )
    else:
        bridge_page.append("(none)")
    (out_root / "bridges.md").write_text("\n".join(bridge_page))

    # ---- communities/*.md ---------------------------------------------
    communities_dir = out_root / "communities"
    communities_dir.mkdir(exist_ok=True)
    for c in communities:
        members = memberships.get(c["id"], [])
        member_set = set(members)
        ranked = sorted(
            (nodes_by_id[m] for m in members if m in nodes_by_id),
            key=lambda n: len(out_edges.get(n["id"], [])),
            reverse=True,
        )
        god_note = " Flagged as a god community." if c.get("is_god") else ""
        page = [
            f"# {c['name']}",
            "",
            f"{len(ranked)}-member community with cohesion {c.get('cohesion', 0.0):.2f}.{god_note}",
            "",
            f"## Members (highest degree first, top {list_cap})",
        ]
        page.extend(f"- {_display_name(n)} ({n['type']})" for n in ranked[:list_cap])

        # Leaving edges, grouped by the community they land in — the reader
        # wants "who do we talk to and how much", not a flat edge sample.
        leaving: defaultdict[str | None, list[tuple[str, str, str]]] = defaultdict(list)
        for s, t, r in edges:
            if s in member_set and t not in member_set:
                target = community_of.get(t)
                leaving[target["id"] if target else None].append((s, t, r))
        if leaving:
            page += ["", "## Connections to other communities"]
            for target_id, group in sorted(leaving.items(), key=lambda kv: -len(kv[1]))[:list_cap]:
                samples = "; ".join(
                    f"{_display_name(nodes_by_id[s])} → {_display_name(nodes_by_id[t])} ({r})" for s, t, r in group[:3]
                )
                count = f"{len(group)} edge" + ("s" if len(group) != 1 else "")
                if target_id is None:
                    page.append(f"- (no community): {count} — {samples}")
                else:
                    target_c = community_by_id[target_id]
                    page.append(f"- [{target_c['name']}]({community_slug[target_id]}.md): {count} — {samples}")

        (communities_dir / f"{community_slug[c['id']]}.md").write_text("\n".join(page))

    # ---- gods/*.md -----------------------------------------------------
    gods_dir = out_root / "gods"
    gods_dir.mkdir(exist_ok=True)
    for g in god_nodes:
        page = [f"# {g['name']}", "", f"**Type**: {g['type']}", f"**Degree**: {g['degree']}"]
        home = community_of.get(g["id"])
        if home:
            page.append(f"Belongs to the [{home['name']}](../communities/{community_slug[home['id']]}.md) community.")
        neighbours_by_rel: defaultdict[str, list[str]] = defaultdict(list)
        for rel, other in out_edges.get(g["id"], []):
            neighbours_by_rel[rel].append(nodes_by_id[other]["name"])
        if neighbours_by_rel:
            page += ["", "## Relationships"]
            page.extend(f"- {rel}: {', '.join(names[:list_cap])}" for rel, names in neighbours_by_rel.items())
        (gods_dir / f"{god_slug[g['id']]}.md").write_text("\n".join(page))

    click.echo(
        f"Report written to {out_root}: {len(communities)} community pages, "
        f"{len(god_nodes)} god-node pages, bridges.md."
    )
