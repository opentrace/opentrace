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

import { type ReactNode, useState } from 'react';
import type { SelectedNode } from '@opentrace/components/utils';
import { getNodeColor } from '@opentrace/components/utils';
import type { NodeSourceResponse } from '../store/types';
import { IMAGE_MIME_TYPES } from '../runner/browser/loader/constants';
import { Highlight, themes } from 'prism-react-renderer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from '../chat/markdownComponents';
import {
  GitHubIcon,
  GitLabIcon,
  BitbucketIcon,
  AzureDevOpsIcon,
} from './providerIcons';
import './NodeDetailsPanel.css';

/** Node types whose source code can be fetched and displayed. */
const SOURCE_TYPES = new Set(['File', 'Function', 'Class', 'PullRequest']);

/** Map file extensions → Prism language identifiers. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  toml: 'toml',
  sql: 'sql',
  css: 'css',
  html: 'markup',
  xml: 'markup',
  md: 'markdown',
  graphql: 'graphql',
  proto: 'protobuf',
  dockerfile: 'docker',
  makefile: 'makefile',
};

function NpmIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor">
      <path d="M0 256V0h256v256z" fillOpacity="0" />
      <path d="M48 48v160h80V88h40v120h40V48z" />
    </svg>
  );
}

function PypiIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 32 32" fill="currentColor">
      <path d="M15.885.47l-8.52 3.164v6.406l-4.32 1.602v12.762l8.535 3.164v-6.328l4.305-1.598V6.875zm-.117 2.422v5.45l-4.172 1.55V4.44zm4.422 2.082v6.32l4.305 1.6v12.765l-8.524 3.164v-6.406l-4.176-1.551v-6.32l4.176-1.551V6.578zM24.5 8.578v5.453l-4.172 1.547V10.13z" />
    </svg>
  );
}

function GoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <text
        x="1"
        y="13"
        fontSize="13"
        fontFamily="system-ui, sans-serif"
        fontWeight="bold"
      >
        Go
      </text>
    </svg>
  );
}

function CratesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 512 512" fill="currentColor">
      <path d="M235.5 3.7L37.2 113.4v226.8L235.5 450v-90.4l-128-68.5V181.5l128-68.5V3.7zm40.9 0v109.3l128 68.5v136.4l-128 68.5V496l198.3-109.7V159.5L276.4 3.7z" />
    </svg>
  );
}

/** Map source_name to an icon component. */
const PROVIDER_ICONS: Record<string, () => ReactNode> = {
  github: () => <GitHubIcon size={16} />,
  gitlab: () => <GitLabIcon size={16} />,
  bitbucket: () => <BitbucketIcon size={16} />,
  azuredevops: () => <AzureDevOpsIcon size={16} />,
  npm: NpmIcon,
  pypi: PypiIcon,
  go: GoIcon,
  crates: CratesIcon,
};

/** Human-readable provider names for the "View on …" link label. */
const PROVIDER_DISPLAY: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azuredevops: 'Azure DevOps',
  npm: 'npm',
  pypi: 'PyPI',
  go: 'pkg.go.dev',
  crates: 'crates.io',
};

/** Resolve a Prism language from the source response or file path. */
function detectLanguage(source: NodeSourceResponse): string {
  if (source.language) {
    const lower = source.language.toLowerCase();
    // Already a prism name or in our map
    return EXT_TO_LANG[lower] ?? lower;
  }
  const ext = source.path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? 'plaintext';
}

interface NodeDetailsPanelProps {
  node: SelectedNode;
  nodeSource: NodeSourceResponse | null;
  sourceLoading: boolean;
  sourceError: string | null;
  communityName?: string;
  communityColor?: string;
}

type PreviewTab = 'rendered' | 'raw';

/** Decode SVG content to a raw XML string regardless of encoding. */
function decodeSvgContent(source: NodeSourceResponse): string {
  if (!source.binary) return source.content;
  try {
    return atob(source.content);
  } catch {
    return source.content;
  }
}

export default function NodeDetailsPanel({
  node,
  nodeSource,
  sourceLoading,
  sourceError,
  communityName,
  communityColor,
}: NodeDetailsPanelProps) {
  const [previewTab, setPreviewTab] = useState<PreviewTab>('rendered');
  const color = getNodeColor(node.type);
  const isLight = document.documentElement.dataset.mode === 'light';
  const prismTheme = isLight ? themes.oneLight : themes.oneDark;

  const hasEnrichment = !!(
    node.properties?.summary || node.properties?.has_embedding
  );
  const sourceUri = node.properties?.source_uri as string | undefined;
  const sourceName = (
    node.properties?.source_name as string | undefined
  )?.toLowerCase();
  const ProviderIcon = sourceName ? PROVIDER_ICONS[sourceName] : undefined;

  return (
    <div className="node-details-content">
      {/* ── Header: [type] name … [View on] ── */}
      <div className="detail-header">
        <span className="type-badge" style={{ backgroundColor: color }}>
          {node.type}
        </span>
        {communityName && (
          <span
            className="type-badge community-badge"
            style={{
              color: communityColor ?? '#64748b',
              border: `1.5px solid ${communityColor ?? '#64748b'}`,
            }}
          >
            {communityName}
          </span>
        )}
        <span className="detail-name">{node.name || 'N/A'}</span>
        {sourceUri && (
          <a
            className="source-link"
            href={sourceUri}
            target="_blank"
            rel="noopener noreferrer"
          >
            {ProviderIcon ? (
              <ProviderIcon />
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            )}
            <span className="source-link-text">
              {sourceName
                ? `View on ${PROVIDER_DISPLAY[sourceName] ?? sourceName.charAt(0).toUpperCase() + sourceName.slice(1)}`
                : 'View source'}
            </span>
          </a>
        )}
      </div>

      {/* ── Enrichment pips right after name ── */}
      {hasEnrichment && (
        <div className="enrichment-pips">
          {!!node.properties?.summary && (
            <span className="enrichment-pip enrichment-pip--summarized">
              <span className="enrichment-pip-dot" />
              Summarized
            </span>
          )}
          {!!node.properties?.has_embedding && (
            <span className="enrichment-pip enrichment-pip--embedded">
              <span className="enrichment-pip-dot" />
              Embedded
            </span>
          )}
        </div>
      )}

      {/* ── Properties ── */}
      {node.properties && Object.keys(node.properties).length > 0 && (
        <div className="properties-section">
          <h4>Properties</h4>
          {Object.entries(node.properties)
            .filter(
              ([k]) =>
                k !== 'has_embedding' &&
                k !== 'source_uri' &&
                k !== 'source_name',
            )
            .map(([k, v]) => (
              <div key={k} className="detail-row">
                <span className="label">{k}</span>
                <span className="value">{String(v)}</span>
              </div>
            ))}
        </div>
      )}

      {/* ── Source / body viewer ── */}
      {SOURCE_TYPES.has(node.type) && (
        <div className="source-section">
          <h4>
            {node.type === 'PullRequest' ? 'Description' : 'Source'}
            {nodeSource && node.type !== 'PullRequest' && (
              <span className="source-path">{nodeSource.path}</span>
            )}
          </h4>
          {sourceLoading && (
            <div className="source-loading">Loading source...</div>
          )}
          {sourceError && <div className="source-error">{sourceError}</div>}
          {nodeSource && node.type === 'PullRequest' && (
            <div className="pr-body-content message-content">
              <div className="markdown-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {nodeSource.content}
                </ReactMarkdown>
              </div>
            </div>
          )}
          {nodeSource &&
            node.type !== 'PullRequest' &&
            (() => {
              const dotIdx = nodeSource.path.lastIndexOf('.');
              const ext =
                dotIdx >= 0 ? nodeSource.path.slice(dotIdx).toLowerCase() : '';
              const mime = IMAGE_MIME_TYPES[ext];
              const isSvg = ext === '.svg';

              // SVG files: tabbed Rendered / Raw view
              if (isSvg) {
                const rawXml = decodeSvgContent(nodeSource);
                const imgSrc = nodeSource.binary
                  ? `data:image/svg+xml;base64,${nodeSource.content}`
                  : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rawXml)}`;
                return (
                  <div className="preview-viewer">
                    <div className="preview-tab-bar">
                      <button
                        className={`preview-tab ${previewTab === 'rendered' ? 'active' : ''}`}
                        onClick={() => setPreviewTab('rendered')}
                      >
                        Rendered
                      </button>
                      <button
                        className={`preview-tab ${previewTab === 'raw' ? 'active' : ''}`}
                        onClick={() => setPreviewTab('raw')}
                      >
                        Raw
                      </button>
                    </div>
                    {previewTab === 'rendered' ? (
                      <div className="source-image-preview">
                        <img src={imgSrc} alt={nodeSource.path} />
                      </div>
                    ) : (
                      <div className="source-viewer">
                        <Highlight
                          theme={prismTheme}
                          code={rawXml}
                          language="markup"
                        >
                          {({ tokens, getLineProps, getTokenProps, style }) => (
                            <pre className="source-code" style={style}>
                              <code>
                                {tokens.map((line, i) => {
                                  const lineProps = getLineProps({ line });
                                  return (
                                    <div
                                      {...lineProps}
                                      key={i}
                                      className="source-line"
                                    >
                                      <span className="line-number">
                                        {i + 1}
                                      </span>
                                      <span className="line-content">
                                        {line.map((token, j) => (
                                          <span
                                            key={j}
                                            {...getTokenProps({ token })}
                                          />
                                        ))}
                                      </span>
                                    </div>
                                  );
                                })}
                              </code>
                            </pre>
                          )}
                        </Highlight>
                      </div>
                    )}
                  </div>
                );
              }

              // Markdown files: tabbed Rendered / Raw view
              if (ext === '.md' || ext === '.mdx') {
                return (
                  <div className="preview-viewer">
                    <div className="preview-tab-bar">
                      <button
                        className={`preview-tab ${previewTab === 'rendered' ? 'active' : ''}`}
                        onClick={() => setPreviewTab('rendered')}
                      >
                        Rendered
                      </button>
                      <button
                        className={`preview-tab ${previewTab === 'raw' ? 'active' : ''}`}
                        onClick={() => setPreviewTab('raw')}
                      >
                        Raw
                      </button>
                    </div>
                    {previewTab === 'rendered' ? (
                      <div className="pr-body-content message-content">
                        <div className="markdown-body">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={markdownComponents}
                          >
                            {nodeSource.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ) : (
                      <div className="source-viewer">
                        <Highlight
                          theme={prismTheme}
                          code={nodeSource.content}
                          language="markdown"
                        >
                          {({ tokens, getLineProps, getTokenProps, style }) => (
                            <pre className="source-code" style={style}>
                              <code>
                                {tokens.map((line, i) => {
                                  const lineProps = getLineProps({ line });
                                  return (
                                    <div
                                      {...lineProps}
                                      key={i}
                                      className="source-line"
                                    >
                                      <span className="line-number">
                                        {i + 1}
                                      </span>
                                      <span className="line-content">
                                        {line.map((token, j) => (
                                          <span
                                            key={j}
                                            {...getTokenProps({ token })}
                                          />
                                        ))}
                                      </span>
                                    </div>
                                  );
                                })}
                              </code>
                            </pre>
                          )}
                        </Highlight>
                      </div>
                    )}
                  </div>
                );
              }

              if (nodeSource.binary && mime) {
                return (
                  <div className="source-image-preview">
                    <img
                      src={`data:${mime};base64,${nodeSource.content}`}
                      alt={nodeSource.path}
                    />
                  </div>
                );
              }

              // Non-image binary file — show a placeholder instead of garbled bytes
              if (nodeSource.binary || nodeSource.content.includes('\0')) {
                return (
                  <div className="source-binary-notice">
                    Binary file &mdash; cannot display preview
                  </div>
                );
              }

              return (
                <div className="source-viewer">
                  {nodeSource.start_line && nodeSource.end_line ? (
                    <div className="source-line-info">
                      Lines {nodeSource.start_line}&ndash;{nodeSource.end_line}{' '}
                      of {nodeSource.line_count}
                    </div>
                  ) : null}
                  <Highlight
                    theme={prismTheme}
                    code={nodeSource.content}
                    language={detectLanguage(nodeSource)}
                  >
                    {({ tokens, getLineProps, getTokenProps, style }) => (
                      <pre className="source-code" style={style}>
                        <code>
                          {tokens.map((line, i) => {
                            const lineNum = (nodeSource.start_line || 1) + i;
                            const lineProps = getLineProps({ line });
                            return (
                              <div
                                {...lineProps}
                                key={i}
                                className="source-line"
                              >
                                <span className="line-number">{lineNum}</span>
                                <span className="line-content">
                                  {line.map((token, j) => (
                                    <span
                                      key={j}
                                      {...getTokenProps({ token })}
                                    />
                                  ))}
                                </span>
                              </div>
                            );
                          })}
                        </code>
                      </pre>
                    )}
                  </Highlight>
                </div>
              );
            })()}
        </div>
      )}

      {/* ── ID at the very bottom ── */}
      <div className="detail-id-footer">
        <span className="label">ID</span>
        <span className="id-value">{node.id}</span>
      </div>
    </div>
  );
}
