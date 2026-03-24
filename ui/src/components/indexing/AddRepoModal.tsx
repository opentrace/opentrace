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

import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AddRepoModalProps } from './types';
import './indexing-base.css';
import './AddRepoModal.css';

import { detectProvider } from './urlNormalize';

type SourceMode = 'url' | 'directory' | 'import';

const HISTORY_KEY = 'ot_repo_history';
const MAX_HISTORY = 5;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function saveToHistory(url: string) {
  const history = loadHistory().filter((u) => u !== url);
  history.unshift(url);
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(history.slice(0, MAX_HISTORY)),
  );
}

function removeFromHistory(url: string): string[] {
  const updated = loadHistory().filter((u) => u !== url);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  return updated;
}

const PROVIDER_ORDER = [
  'github',
  'gitlab',
  'bitbucket',
  'azuredevops',
] as const;

/**
 * Clip-path polygons for each provider's quadrant.
 * All use 4-point polygons so CSS can interpolate between states.
 *
 * Layout: GitHub=top, GitLab=right, Bitbucket=bottom, AzureDevOps=left
 */
const QUADRANT_CLIPS: Record<
  string,
  { quarter: string; full: string; hidden: string }
> = {
  github: {
    // top triangle
    quarter: 'polygon(0% 0%, 100% 0%, 50% 50%, 50% 50%)',
    full: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
    hidden: 'polygon(50% 50%, 50% 50%, 50% 50%, 50% 50%)',
  },
  gitlab: {
    // right triangle
    quarter: 'polygon(50% 50%, 100% 0%, 100% 100%, 50% 50%)',
    full: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
    hidden: 'polygon(50% 50%, 50% 50%, 50% 50%, 50% 50%)',
  },
  bitbucket: {
    // bottom triangle
    quarter: 'polygon(50% 50%, 50% 50%, 100% 100%, 0% 100%)',
    full: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
    hidden: 'polygon(50% 50%, 50% 50%, 50% 50%, 50% 50%)',
  },
  azuredevops: {
    // left triangle
    quarter: 'polygon(0% 0%, 50% 50%, 50% 50%, 0% 100%)',
    full: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
    hidden: 'polygon(50% 50%, 50% 50%, 50% 50%, 50% 50%)',
  },
};

/** Full-size SVGs (fill their container) for the clip-path composite. */
const PROVIDER_FULL_SVG: Record<string, () => ReactNode> = {
  github: () => (
    <svg width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
  gitlab: () => (
    <svg width="100%" height="100%" viewBox="0 0 380 380" fill="currentColor">
      <path d="M190 353.9L131.1 172.8h117.8L190 353.9z" opacity="0.85" />
      <path d="M190 353.9L131.1 172.8H15.6L190 353.9z" opacity="0.7" />
      <path
        d="M15.6 172.8L0.4 219.5c-1.4 4.3 0.1 9 3.8 11.7L190 353.9 15.6 172.8z"
        opacity="0.55"
      />
      <path
        d="M15.6 172.8h115.5L87.6 26.5c-1.6-4.9-8.5-4.9-10.1 0L15.6 172.8z"
        opacity="0.85"
      />
      <path d="M190 353.9l58.9-181.1h115.5L190 353.9z" opacity="0.7" />
      <path
        d="M364.4 172.8l15.2 46.7c1.4 4.3-0.1 9-3.8 11.7L190 353.9l174.4-181.1z"
        opacity="0.55"
      />
      <path
        d="M364.4 172.8H248.9l43.5-146.3c1.6-4.9 8.5-4.9 10.1 0l61.9 146.3z"
        opacity="0.85"
      />
    </svg>
  ),
  bitbucket: () => (
    <svg width="100%" height="100%" viewBox="0 0 32 32" fill="currentColor">
      <path d="M2.278 2.133a1.07 1.07 0 00-1.07 1.236l4.058 24.637a1.45 1.45 0 001.417 1.195h19.1a1.07 1.07 0 001.07-.903l4.058-24.93a1.07 1.07 0 00-1.07-1.236zm16.7 17.757h-6.1l-1.647-8.613h9.2z" />
    </svg>
  ),
  azuredevops: () => (
    <svg width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor">
      <path d="M15 3.622v8.512L11.5 15l-5.425-1.975v1.958L3.004 10.97l8.951.7V4.005L15 3.622zm-2.984.428L6.994 1v2.001L2.382 4.356 1 6.13v4.029l1.978.873V5.869l9.038-1.819z" />
    </svg>
  ),
};

function ProviderIconStrip({ selected }: { selected: string | null }) {
  return (
    <div className={'hero-icon' + (selected ? ' hero-icon--provider' : '')}>
      {/* X-shaped divider lines */}
      <svg
        className={`quad-dividers${selected ? ' quad-dividers--hidden' : ''}`}
        width="100%"
        height="100%"
        viewBox="0 0 64 64"
      >
        <line
          x1="0"
          y1="0"
          x2="64"
          y2="64"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.2"
        />
        <line
          x1="64"
          y1="0"
          x2="0"
          y2="64"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.2"
        />
      </svg>
      {/* Four icon layers, each clipped to a quadrant */}
      {PROVIDER_ORDER.map((key) => {
        const Icon = PROVIDER_FULL_SVG[key];
        const clips = QUADRANT_CLIPS[key];
        const clip = !selected
          ? clips.quarter
          : key === selected
            ? clips.full
            : clips.hidden;
        return (
          <div key={key} className="quad-layer" style={{ clipPath: clip }}>
            <Icon />
          </div>
        );
      })}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg
      width="38"
      height="38"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg
      width="38"
      height="38"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

const PROVIDER_DISPLAY_NAME: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azuredevops: 'Azure DevOps',
};

// --- Example Repositories ---

type RepoSize = 'S' | 'M' | 'L';

const EXAMPLE_REPOS: {
  name: string;
  url: string;
  description: string;
  size: RepoSize;
}[] = [
  {
    name: 'OpenTrace',
    url: 'https://github.com/opentrace/opentrace',
    description: 'Knowledge graph for system architecture and code structure',
    size: 'M',
  },
  {
    name: 'OpenTelemetry Demo',
    url: 'https://github.com/open-telemetry/opentelemetry-demo',
    description: 'Microservices demo with OTel instrumentation',
    size: 'M',
  },
  {
    name: 'Express.js',
    url: 'https://github.com/expressjs/express',
    description: 'Fast, minimalist web framework for Node.js',
    size: 'S',
  },
  {
    name: 'Podinfo',
    url: 'https://github.com/stefanprodan/podinfo',
    description: 'Go microservice template for Kubernetes',
    size: 'S',
  },
  {
    name: 'Grafana',
    url: 'https://github.com/grafana/grafana',
    description: 'Open-source observability and monitoring platform',
    size: 'L',
  },
  {
    name: 'Linux',
    url: 'https://github.com/torvalds/linux',
    description: 'Linux kernel source tree',
    size: 'L',
  },
];

// --- Main Component ---

export default function AddRepoModal({
  onClose,
  onSubmit,
  dismissable = true,
  onValidate,
}: AddRepoModalProps) {
  const [source, setSource] = useState<SourceMode>('url');
  const [repoUrl, setRepoUrl] = useState('');
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [ref, setRef] = useState('');
  const [pat, setPat] = useState('');
  const [showPat, setShowPat] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Reliably focus the URL input when the modal mounts
  useEffect(() => {
    if (source === 'url') {
      urlInputRef.current?.focus();
    }
  }, [source]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        e.target !== urlInputRef.current
      ) {
        setShowHistory(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filteredHistory = history.filter(
    (url) => !repoUrl || url.toLowerCase().includes(repoUrl.toLowerCase()),
  );

  const provider = source === 'url' ? detectProvider(repoUrl) : null;
  const patStorageKey = provider ? `ot_${provider}_pat` : null;

  // Let the consumer validate the URL (e.g. duplicate detection)
  const validationMessage = useMemo(() => {
    if (source !== 'url' || !repoUrl.trim() || !onValidate) return null;
    return onValidate(repoUrl);
  }, [source, repoUrl, onValidate]);

  // Derive directory name from FileList
  const directoryName =
    selectedFiles?.[0]?.webkitRelativePath?.split('/')[0] ?? '';

  // Load saved PAT for the detected provider
  useEffect(() => {
    if (!provider || !patStorageKey) return;
    const saved = localStorage.getItem(patStorageKey);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from localStorage
    if (saved) setPat(saved);
    else setPat('');
  }, [provider, patStorageKey]);

  // Clear errors when switching source mode
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on dep change
    setError(null);
  }, [source]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (source === 'import') {
      if (!importFile) {
        setError('Select a .parquet.zip file first.');
        return;
      }
      setError(null);
      setLoading(true);
      onSubmit({
        type: 'import-file',
        file: importFile,
        name: importFile.name
          .replace(/\.parquet\.zip$/i, '')
          .replace(/\.zip$/i, ''),
      });
      return;
    }

    if (source === 'directory') {
      if (!selectedFiles || selectedFiles.length === 0) {
        setError('Select a directory first.');
        return;
      }
      setError(null);
      setLoading(true);
      onSubmit({
        type: 'index-directory',
        files: selectedFiles,
        name: directoryName || 'local',
      });
      return;
    }

    // URL mode
    if (!provider) {
      setError(
        'Enter a GitHub, GitLab, Bitbucket, or Azure DevOps repository URL.',
      );
      return;
    }
    if (validationMessage) {
      return;
    }
    setError(null);
    setLoading(true);

    if (patStorageKey) {
      if (pat) localStorage.setItem(patStorageKey, pat);
      else localStorage.removeItem(patStorageKey);
    }

    saveToHistory(repoUrl);

    onSubmit({
      type: 'index-repo',
      repoUrl,
      token: pat || undefined,
      ref: ref || undefined,
    });
  }

  // --- Hero content based on source mode ---

  const heroIcon =
    source === 'import' ? (
      <div className="hero-icon hero-icon--provider">
        <ImportIcon />
      </div>
    ) : source === 'directory' ? (
      <div className="hero-icon hero-icon--provider">
        <FolderIcon />
      </div>
    ) : (
      <ProviderIconStrip selected={provider} />
    );

  const title =
    source === 'import'
      ? 'Import Graph'
      : source === 'directory'
        ? 'Add Local Directory'
        : provider
          ? `Add from ${PROVIDER_DISPLAY_NAME[provider]}`
          : 'Add Repository';

  const subtitle =
    source === 'import'
      ? 'Upload a LadybugDB file to load into the graph'
      : source === 'directory'
        ? 'Select a directory to index its structure into the graph'
        : provider
          ? `Enter a ${PROVIDER_DISPLAY_NAME[provider]} repository URL to index`
          : 'Enter a repository URL to index its structure into the graph';

  return (
    <div className="modal-backdrop" onClick={dismissable ? onClose : undefined}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Source mode toggle */}
        <div className="source-toggle">
          <div className="chip-toggle">
            <button
              type="button"
              className={`chip-toggle-btn${source === 'url' ? ' active' : ''}`}
              onClick={() => setSource('url')}
            >
              URL
            </button>
            <button
              type="button"
              className={`chip-toggle-btn${source === 'directory' ? ' active' : ''}`}
              onClick={() => setSource('directory')}
            >
              Directory
            </button>
            <button
              type="button"
              className={`chip-toggle-btn${source === 'import' ? ' active' : ''}`}
              onClick={() => setSource('import')}
            >
              Import
            </button>
          </div>
        </div>

        <div className="form-hero">
          {heroIcon}
          <h2>{title}</h2>
          <p className="hero-subtitle">{subtitle}</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-fields">
            {source === 'import' ? (
              <div className="import-picker">
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".zip"
                  className="directory-input"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                />
                <div
                  className={`import-dropzone${dragging ? ' import-dropzone--active' : ''}${importFile ? ' import-dropzone--has-file' : ''}`}
                  onClick={() => importInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragging(true);
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragging(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragging(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragging(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) setImportFile(file);
                  }}
                >
                  {importFile ? (
                    <>
                      <svg
                        className="import-dropzone-icon"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <ellipse cx="12" cy="5" rx="9" ry="3" />
                        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                      </svg>
                      <span className="import-dropzone-filename">
                        {importFile.name}
                      </span>
                      <span className="import-dropzone-size">
                        {(importFile.size / 1024 / 1024).toFixed(1)} MB
                      </span>
                    </>
                  ) : (
                    <>
                      <svg
                        className="import-dropzone-icon"
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <span className="import-dropzone-label">
                        Drop .parquet.zip file here or click to browse
                      </span>
                    </>
                  )}
                </div>
                <div className="form-info">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  <span>
                    Upload a Parquet zip archive (typically{' '}
                    <code className="form-info-code">
                      opentrace.parquet.zip
                    </code>
                    ) exported from OpenTrace.
                  </span>
                </div>
              </div>
            ) : source === 'url' ? (
              <>
                <div className="form-info">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                  <span>
                    Repository archives are fetched through the OpenTrace API
                    server to avoid browser CORS restrictions. Your access token
                    (if provided) is forwarded but never stored on the server.
                  </span>
                </div>

                {!provider && (
                  <div className="example-repos">
                    <span className="example-repos-label">Examples:</span>
                    {EXAMPLE_REPOS.map((repo) => (
                      <button
                        key={repo.url}
                        type="button"
                        className="example-repo-chip"
                        onClick={() => setRepoUrl(repo.url)}
                        title={repo.description}
                      >
                        {repo.name}
                        <span
                          className={`example-repo-size example-repo-size--${repo.size.toLowerCase()}`}
                        >
                          {repo.size}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="autocomplete-wrapper">
                  <input
                    ref={urlInputRef}
                    type="text"
                    required
                    className="input-pill"
                    placeholder="https://github.com/owner/repo or https://bitbucket.org/ws/repo"
                    value={repoUrl}
                    onChange={(e) => {
                      setRepoUrl(e.target.value);
                      if (!showHistory) setShowHistory(true);
                    }}
                    onFocus={() => setShowHistory(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setShowHistory(false);
                    }}
                    autoFocus
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    data-testid="repo-url-input"
                  />
                  {showHistory && filteredHistory.length > 0 && (
                    <div ref={dropdownRef} className="autocomplete-dropdown">
                      <div className="autocomplete-label">Recent</div>
                      {filteredHistory.map((url) => (
                        <div
                          key={url}
                          className="autocomplete-item"
                          role="option"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setRepoUrl(url);
                            setShowHistory(false);
                            urlInputRef.current?.focus();
                          }}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="1 4 1 10 7 10" />
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                          </svg>
                          <span className="autocomplete-item-text">
                            {url
                              .replace(/^https?:\/\/(www\.)?/, '')
                              .replace(/\.git$/, '')}
                          </span>
                          <button
                            type="button"
                            className="autocomplete-item-remove"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setHistory(removeFromHistory(url));
                            }}
                            aria-label="Remove from history"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                              <path d="M10 11v6" />
                              <path d="M14 11v6" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {provider && (
                  <div className="input-pill-row">
                    <svg
                      className="input-icon"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <input
                      type={showPat ? 'text' : 'password'}
                      className="input-pill input-pill--icon"
                      placeholder={`${provider ? PROVIDER_DISPLAY_NAME[provider] : ''} access token (optional, for private repos)`}
                      value={pat}
                      onChange={(e) => setPat(e.target.value)}
                    />
                    <button
                      type="button"
                      className="input-toggle"
                      onClick={() => setShowPat(!showPat)}
                      tabIndex={-1}
                      aria-label={showPat ? 'Hide token' : 'Show token'}
                    >
                      {showPat ? (
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
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                        </svg>
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
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="directory-picker">
                <input
                  ref={fileInputRef}
                  type="file"
                  /* @ts-expect-error webkitdirectory is non-standard but widely supported */
                  webkitdirectory=""
                  directory=""
                  multiple
                  className="directory-input"
                  onChange={(e) => setSelectedFiles(e.target.files)}
                />
                <button
                  type="button"
                  className="input-pill directory-browse-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
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
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  {directoryName ? (
                    <span className="directory-name">
                      {directoryName}{' '}
                      <span className="directory-count">
                        ({selectedFiles?.length ?? 0} files)
                      </span>
                    </span>
                  ) : (
                    'Choose Directory...'
                  )}
                </button>
              </div>
            )}
          </div>

          {error && (
            <div className="form-error">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {validationMessage && (
            <div className="form-indexed">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>{validationMessage}</span>
            </div>
          )}

          <button
            type="submit"
            className="btn-cta"
            disabled={loading || !!validationMessage}
          >
            {loading ? (
              <>
                <span className="btn-spinner" />
                {source === 'import' ? 'Importing...' : 'Indexing...'}
              </>
            ) : (
              <>
                {source === 'import' ? 'Import' : 'Add & Index'}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </>
            )}
          </button>

          <div className="form-chips">
            {source === 'url' && (
              <div className="chip">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <input
                  type="text"
                  className="chip-input"
                  placeholder="Branch: main"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                />
              </div>
            )}
            {dismissable && (
              <button type="button" className="chip" onClick={onClose}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
