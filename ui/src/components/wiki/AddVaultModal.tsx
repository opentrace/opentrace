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

import { useCallback, useMemo, useRef, useState } from 'react';
import type { VaultScope } from '../../wiki/types';
import { ThemedSelect } from '../ThemedSelect';
import {
  loadApiKey,
  loadLocalUrl,
  loadProviderChoice,
} from '../../chat/storage';
import { PROVIDERS } from '../../chat/providers';
import { useCompileJob } from '../../providers/CompileJobProvider';
// Shell + form primitives shared with the indexing modal so the two
// pop-ups read as one family (.modal-card, .form-hero,
// .input-pill, .import-dropzone, .btn-cta).
import '../indexing/indexing-base.css';
import '../indexing/AddRepoModal.css';
import './wiki.css';

type WikiProvider = 'anthropic' | 'gemini' | 'openai' | 'local';

const SUPPORTED: WikiProvider[] = ['anthropic', 'gemini', 'openai', 'local'];

function pickInitialProvider(): WikiProvider {
  const saved = loadProviderChoice();
  return SUPPORTED.includes(saved as WikiProvider)
    ? (saved as WikiProvider)
    : 'anthropic';
}

interface Props {
  scope: VaultScope;
  /** When set, the modal appends files to this existing vault: the name is
   *  fixed (no name input) and cancel won't delete the vault. When absent,
   *  the modal creates a new vault and shows a name input. A new compile
   *  auto-suffixes on the server if the name collides, so the modal doesn't
   *  need the existing-vault list. */
  appendTo?: string;
  onClose: () => void;
}

export function AddVaultModal({ scope, appendTo, onClose }: Props) {
  const { state: compileState, start: startCompile } = useCompileJob();
  const appending = !!appendTo;
  const [newVaultName, setNewVaultName] = useState('');
  const [provider, setProvider] = useState<WikiProvider>(pickInitialProvider);
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A background compile is already in flight — block starting a second one.
  const compileBusy = compileState.status === 'running';

  const apiKey = useMemo(() => loadApiKey(provider), [provider]);
  const baseUrl = useMemo(
    () => (provider === 'local' ? loadLocalUrl() : ''),
    [provider],
  );
  // Local endpoints don't validate API keys, so the modal only requires
  // a key for the hosted providers.
  const keyOk = provider === 'local' || !!apiKey;
  const baseUrlOk = provider !== 'local' || !!baseUrl;
  const targetName = appending ? appendTo : newVaultName.trim();
  const submittable =
    keyOk && baseUrlOk && !!targetName && files.length > 0 && !compileBusy;

  // Accumulate across multiple picks/drops rather than replacing — so the
  // user can click "Browse files", add one, click again, add another, etc.
  // Deduped by name+size+lastModified so re-selecting the same file is a
  // no-op instead of a duplicate upload.
  const addFiles = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    setFiles((prev) => {
      const key = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;
      const seen = new Set(prev.map(key));
      const merged = [...prev];
      for (const f of incoming) {
        if (!seen.has(key(f))) {
          seen.add(key(f));
          merged.push(f);
        }
      }
      return merged;
    });
  }, []);

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      // A plain <input type="file"> surfaces no directories. Filter
      // defensively in case some browser/OS surfaces a directory-shaped
      // File anyway (size 0, no type).
      const out = Array.from(fileList).filter((f) => f.size > 0 || !!f.type);
      addFiles(out);
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      addFiles(await collectDroppedFiles(e.dataTransfer));
    },
    [addFiles],
  );

  // Kick off the compile in the background and close the modal immediately —
  // progress now surfaces in the bottom-left CompileProgressPanel.
  const handleSubmit = useCallback(() => {
    if (!submittable) return;
    startCompile({
      vaultName: targetName,
      files,
      apiKey,
      provider,
      baseUrl: provider === 'local' ? baseUrl : undefined,
      scope,
      // "+ Compile new" always produces a fresh vault (auto-suffixed if the
      // name collides), so cancel may delete it. Appending must never wipe the
      // existing vault's prior documents.
      isNew: !appending,
      // Appending updates the named vault in place; a new compile auto-suffixes
      // (flask → flask-1) if the name is taken in either scope.
      onConflict: appending ? 'append' : 'suffix',
    });
    onClose();
  }, [
    submittable,
    startCompile,
    targetName,
    files,
    apiKey,
    provider,
    baseUrl,
    scope,
    appending,
    onClose,
  ]);

  const providerName = PROVIDERS[provider]?.name ?? provider;
  const subtitle = appending
    ? `Adds the new docs to "${appendTo}" — one LLM pass labels each one; existing documents are untouched, nothing is removed.`
    : scope === 'global'
      ? 'One LLM pass labels your docs into a global vault in ~/.opentrace/vaults/ — attachable from any project.'
      : 'One LLM pass labels your docs into a project-local vault. Bodies are indexed verbatim, never rewritten.';
  const totalMb = files.reduce((n, f) => n + f.size, 0) / 1024 / 1024;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="form-hero">
          <div className="hero-icon">
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </div>
          <h2>
            {appending ? `Append to ${appendTo}` : `Compile a ${scope} vault`}
          </h2>
          <p className="hero-subtitle">{subtitle}</p>
        </div>

        <div className="form-fields">
          {!keyOk && (
            <div className="form-error">
              <InfoCircleIcon />
              <span>
                No {providerName} API key found. Set one in Chat settings before
                compiling.
              </span>
            </div>
          )}
          {provider === 'local' && !baseUrlOk && (
            <div className="form-error">
              <InfoCircleIcon />
              <span>
                No local LLM URL configured. Set one in Chat settings before
                compiling.
              </span>
            </div>
          )}

          <div className="add-vault-modal__field">
            <span className="add-vault-modal__field-label">Provider</span>
            <ThemedSelect<WikiProvider>
              value={provider}
              onChange={setProvider}
              ariaLabel="Provider"
              options={SUPPORTED.map((id) => ({
                value: id,
                label: PROVIDERS[id]?.name ?? id,
              }))}
            />
          </div>

          {!appending && (
            <div className="add-vault-modal__field">
              <span className="add-vault-modal__field-label">Vault name</span>
              <input
                type="text"
                className="input-pill"
                placeholder="vault-name"
                value={newVaultName}
                onChange={(e) => setNewVaultName(e.target.value)}
                autoFocus
              />
            </div>
          )}

          <div className="add-vault-modal__field">
            <span className="add-vault-modal__field-label">
              Files ({files.length} selected)
            </span>
            <div
              className={`import-dropzone${dragActive ? ' import-dropzone--active' : ''}${files.length ? ' import-dropzone--has-file' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
            >
              {files.length === 0 ? (
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
                    Drop files or a folder here, or click to browse files
                  </span>
                </>
              ) : (
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
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="import-dropzone-filename">
                    {files.length} file{files.length === 1 ? '' : 's'} selected
                  </span>
                  <span className="import-dropzone-size">
                    {totalMb.toFixed(1)} MB
                  </span>
                </>
              )}
            </div>
            <div className="add-vault-modal__pickers">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                Browse files…
              </button>
              {files.length > 0 && (
                <button
                  type="button"
                  className="add-vault-modal__pickers-clear"
                  onClick={() => setFiles([])}
                >
                  Clear
                </button>
              )}
            </div>
            {/* File picker only — no `webkitdirectory` folder picker. The
                folder picker triggers Chromium's native "Upload N files to
                this site?" confirmation, which can't be suppressed. Folders
                are still supported via drag-and-drop (collectDroppedFiles
                walks them through the FileSystem API, prompt-free). */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              // Reset the value after reading so picking the SAME file again
              // still fires onChange (the browser suppresses it otherwise).
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {compileBusy && (
            <div className="form-info">
              <InfoCircleIcon />
              <span>
                A compile is already running — watch its progress in the
                bottom-left panel, or cancel it before starting another.
              </span>
            </div>
          )}
        </div>

        <div className="add-vault-modal__actions">
          <button
            type="button"
            className="btn-cta"
            onClick={handleSubmit}
            disabled={!submittable}
          >
            {appending ? 'Append' : 'Compile'}
          </button>
          <button
            type="button"
            className="btn-cta btn-cta--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoCircleIcon() {
  return (
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
  );
}

/**
 * Expand a drag-and-drop payload into a flat list of `File` objects.
 *
 * When the user drops a folder, the browser adds a single ``File``-shaped
 * entry to ``dataTransfer.files`` whose ``name`` is the folder name and
 * whose bytes can't be read — uploading it crashes the multipart parser
 * server-side. The Webkit FileSystem API on ``DataTransferItem``
 * (``webkitGetAsEntry()``) lets us walk into the directory and surface its
 * real files instead. We use it when available and fall back to the flat
 * list otherwise.
 */
async function collectDroppedFiles(dt: DataTransfer): Promise<File[]> {
  const items = dt.items;
  if (
    !items ||
    items.length === 0 ||
    typeof items[0].webkitGetAsEntry !== 'function'
  ) {
    return Array.from(dt.files ?? []);
  }

  const out: File[] = [];
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry();
    if (!entry) continue;
    tasks.push(walkEntry(entry, out));
  }
  await Promise.all(tasks);
  return out;
}

async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    await new Promise<void>((resolve) => {
      fileEntry.file(
        (file) => {
          out.push(file);
          resolve();
        },
        () => resolve(),
      );
    });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches; loop until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries(
          (entries) => resolve(entries),
          () => resolve([]),
        );
      });
      if (batch.length === 0) break;
      await Promise.all(batch.map((e) => walkEntry(e, out)));
    }
  }
}
