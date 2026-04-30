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

function titleToSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[^\p{ASCII}]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

interface Props {
  markdown: string;
  pages: VaultPageMeta[];
  onPageClick?: (slug: string) => void;
}

export function WikiMarkdown({ markdown, pages, onPageClick }: Props) {
  const slugSet = useMemo(() => new Set(pages.map((p) => p.slug)), [pages]);
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
          pageResolver: (name: string) => [titleToSlug(name)],
          permalinks: Array.from(slugSet),
          hrefTemplate: (slug: string) => `#vault-page:${slug}`,
          wikiLinkClassName: 'wiki-link',
          newClassName: 'wiki-link wiki-link--broken',
        },
      ],
    ],
    [slugSet],
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
