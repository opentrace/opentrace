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

"""``opentraceai wiki`` CLI subcommand — compile files into a vault."""

from __future__ import annotations

import sys
from pathlib import Path

import click


@click.group()
def wiki() -> None:
    """Knowledge-vault commands (compile uploaded files into a markdown wiki)."""


@wiki.command("compile")
@click.argument("vault_name")
@click.argument("files", nargs=-1, required=True, type=click.Path(exists=True, dir_okay=False, resolve_path=True))
@click.option(
    "--provider",
    type=click.Choice(["anthropic", "gemini"]),
    default="anthropic",
    show_default=True,
    help="LLM provider to drive Plan + Execute calls.",
)
@click.option(
    "--api-key",
    default=None,
    help="Provider API key (falls back to ANTHROPIC_API_KEY / GEMINI_API_KEY).",
)
@click.option(
    "--model",
    default=None,
    help="Override the provider's default model.",
)
@click.option(
    "--vault-root",
    default=None,
    type=click.Path(),
    help="Vault root directory (default: ~/.opentrace/vaults; or set OT_VAULT_ROOT).",
)
def wiki_compile(
    vault_name: str,
    files: tuple[str, ...],
    provider: str,
    api_key: str | None,
    model: str | None,
    vault_root: str | None,
) -> None:
    """Compile FILES into VAULT_NAME, producing connected markdown pages."""
    from opentrace_agent.wiki import SourceInput, run_compile
    from opentrace_agent.wiki.ingest.types import WikiEventKind

    inputs: list[SourceInput] = []
    for f in files:
        path = Path(f)
        inputs.append(SourceInput(name=path.name, data=path.read_bytes()))

    click.echo(f"Compiling {len(inputs)} file(s) into vault {vault_name!r} via {provider} ...")

    try:
        for event in run_compile(
            vault_name,
            inputs,
            provider=provider,
            api_key=api_key,
            model=model,
            vault_root=vault_root,
        ):
            _print_event(event)
            if event.kind == WikiEventKind.ERROR:
                sys.exit(2)
    except RuntimeError as e:
        raise click.ClickException(str(e))


def _print_event(event) -> None:
    from opentrace_agent.wiki.ingest.types import WikiEventKind

    if event.kind == WikiEventKind.STAGE_START:
        click.echo(f"  [{event.phase.value}] {event.message}")
    elif event.kind == WikiEventKind.STAGE_PROGRESS:
        if event.total > 0:
            click.echo(f"    [{event.current}/{event.total}] {event.message}")
        else:
            click.echo(f"    {event.message}")
    elif event.kind == WikiEventKind.STAGE_STOP:
        click.echo(f"  [{event.phase.value}] {event.message}")
    elif event.kind == WikiEventKind.DONE:
        click.echo(f"Done: {event.message}")
    elif event.kind == WikiEventKind.ERROR:
        click.echo(f"Error: {event.message}", err=True)
