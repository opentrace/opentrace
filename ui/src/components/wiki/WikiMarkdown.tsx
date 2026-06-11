/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import wikiLinkPlugin from 'remark-wiki-link';
import type { VaultPageMeta } from '../../wiki/types';

interface Props {
  markdown: string;
  pages: VaultPageMeta[];
  onPageClick?: (slug: string) => void;
}

// Sentinel slug used when a [[Title]] doesn't match any known page. It must
// be a value that can never be a real slug so the wiki-link plugin marks
// the link as broken (real slugs are lowercase a-z0-9 plus dashes and a
// single kind-folder prefix).
const UNRESOLVED_SLUG = '__unresolved__';

// PageMeta.kind → on-disk folder name used in slugs. Mirrors `kind_dir`
// in agent/.../wiki/slugify.py.
const KIND_DIRS: Record<string, string> = {
  concept: 'concept',
  file_summary: 'file-summary',
  // Stale graph mirrors compiled before the file-summary rename still
  // carry this kind, with slugs under the matching old folder.
  source_summary: 'source-summary',
};

function kindDirForPage(kind: string | undefined): string {
  return KIND_DIRS[kind ?? 'concept'] ?? 'concept';
}

export function WikiMarkdown({ markdown, pages, onPageClick }: Props) {
  const slugSet = useMemo(() => new Set(pages.map((p) => p.slug)), [pages]);
  // Resolve `[[Title]]` and `[[<kind-dir>/Title]]` against the page list.
  // Slugs are ``<kind_dir>/<base>``; a bare title is unambiguous when it
  // appears in only one kind, otherwise users disambiguate with the
  // path-style form (e.g. `[[concept/Usage]]` vs `[[file-summary/Usage]]`).
  const linkResolver = useMemo(() => {
    const byTitle = new Map<string, string>();
    const byKindedTitle = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const p of pages) {
      const dir = kindDirForPage(p.kind);
      byKindedTitle.set(`${dir}/${p.title}`, p.slug);
      if (byTitle.has(p.title)) {
        ambiguous.add(p.title);
      } else {
        byTitle.set(p.title, p.slug);
      }
    }
    return (name: string): string => {
      // `[[concept/Title]]` / `[[file-summary/Title]]` wins
      // unambiguously over a bare title.
      const kinded = byKindedTitle.get(name);
      if (kinded) return kinded;
      if (ambiguous.has(name)) return UNRESOLVED_SLUG;
      return byTitle.get(name) ?? UNRESOLVED_SLUG;
    };
  }, [pages]);
  const plugins = useMemo(
    () => [
      remarkGfm,
      [
        wikiLinkPlugin,
        {
          // Obsidian uses `|` for "[[Target|displayed text]]"; LLMs default
          // to that syntax. The plugin's own default is `:`, which would
          // treat `Foo|bar` as one slug and break the link.
          aliasDivider: '|',
          pageResolver: (name: string) => [linkResolver(name)],
          permalinks: Array.from(slugSet),
          hrefTemplate: (slug: string) => `#vault-page:${slug}`,
          wikiLinkClassName: 'wiki-link',
          newClassName: 'wiki-link wiki-link--broken',
        },
      ],
    ],
    [slugSet, linkResolver],
  );

  return (
    <div className="wiki-markdown">
      <ReactMarkdown
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        remarkPlugins={plugins as any}
        components={{
          a: ({ href, children, className, ...rest }) => {
            if (typeof href === 'string' && href.startsWith('#vault-page:')) {
              const slug = href.slice('#vault-page:'.length);
              return (
                <a
                  href={href}
                  className={className}
                  onClick={(e) => {
                    e.preventDefault();
                    if (slugSet.has(slug)) onPageClick?.(slug);
                  }}
                  {...rest}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} className={className} {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
