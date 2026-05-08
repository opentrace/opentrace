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
// the link as broken (real slugs are lowercase a-z0-9 plus dashes).
const UNRESOLVED_SLUG = '__unresolved__';

export function WikiMarkdown({ markdown, pages, onPageClick }: Props) {
  const slugSet = useMemo(() => new Set(pages.map((p) => p.slug)), [pages]);
  const titleToSlugMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pages) m.set(p.title, p.slug);
    return m;
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
          // Resolve [[Title]] only by title-exact match against the page
          // list. Re-slugifying client-side breaks for source-summary pages
          // (slug keeps a `source-summary-` prefix that the title doesn't),
          // and silently masks genuinely-broken citations against bodies
          // that reference titles which no longer exist.
          pageResolver: (name: string) => [
            titleToSlugMap.get(name) ?? UNRESOLVED_SLUG,
          ],
          permalinks: Array.from(slugSet),
          hrefTemplate: (slug: string) => `#vault-page:${slug}`,
          wikiLinkClassName: 'wiki-link',
          newClassName: 'wiki-link wiki-link--broken',
        },
      ],
    ],
    [slugSet, titleToSlugMap],
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
