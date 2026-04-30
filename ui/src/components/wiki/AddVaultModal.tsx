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
import { compileVault } from '../../wiki/client';
import type { WikiCompileEvent } from '../../wiki/types';
import { loadApiKey, loadProviderChoice } from '../../chat/storage';
import { PROVIDERS } from '../../chat/providers';

type WikiProvider = 'anthropic' | 'gemini';

const SUPPORTED: WikiProvider[] = ['anthropic', 'gemini'];

function pickInitialProvider(): WikiProvider {
  const saved = loadProviderChoice();
  return SUPPORTED.includes(saved as WikiProvider)
    ? (saved as WikiProvider)
    : 'anthropic';
}

interface Props {
  existingVaults: string[];
  onClose: () => void;
  onCompiled: (vaultName: string) => void;
}

export function AddVaultModal({ existingVaults, onClose, onCompiled }: Props) {
  const [vaultMode, setVaultMode] = useState<'existing' | 'new'>(
    existingVaults.length > 0 ? 'existing' : 'new',
  );
  const [vaultName, setVaultName] = useState(existingVaults[0] ?? '');
  const [newVaultName, setNewVaultName] = useState('');
  const [provider, setProvider] = useState<WikiProvider>(pickInitialProvider);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const apiKey = useMemo(() => loadApiKey(provider), [provider]);
  const targetName = (vaultMode === 'new' ? newVaultName : vaultName).trim();
  const submittable = !!apiKey && !!targetName && files.length > 0 && !running;
  // True once an attempt has finished without a clean compile — flips the
  // primary button label from "Compile" to "Retry".
  const [hasAttempted, setHasAttempted] = useState(false);

  const handleFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    // FileList from <input webkitdirectory> contains real files only — folders
    // are already expanded. From a plain <input type="file"> there are no
    // directories. Filter defensively in case some browser/OS surfaces a
    // directory-shaped File anyway (size 0, no type).
    const out = Array.from(fileList).filter((f) => f.size > 0 || !!f.type);
    setFiles(out);
    setHasAttempted(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const collected = await collectDroppedFiles(e.dataTransfer);
    if (collected.length > 0) {
      setFiles(collected);
      setHasAttempted(false);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!submittable) return;
    setRunning(true);
    setError(null);
    setProgress([]);
    let sawError = false;
    let sawDone = false;
    try {
      for await (const ev of compileVault(targetName, files, apiKey, {
        provider,
      })) {
        setProgress((p) => [...p, formatEvent(ev)]);
        if (ev.kind === 'error') {
          setError(ev.message);
          sawError = true;
        } else if (ev.kind === 'done') {
          sawDone = true;
        }
      }
      // Only auto-close the modal when the compile actually finished
      // cleanly. On error, leave it open so the user can read the log.
      if (sawDone && !sawError) {
        onCompiled(targetName);
      } else {
        setHasAttempted(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHasAttempted(true);
    } finally {
      setRunning(false);
    }
  }, [submittable, targetName, files, apiKey, provider, onCompiled]);

  const providerName = PROVIDERS[provider]?.name ?? provider;

  return (
    <div
      className="add-vault-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div className="add-vault-modal__panel">
        <h3>Compile files into a vault</h3>

        {!apiKey && (
          <div className="add-vault-modal__byok-warning">
            No {providerName} API key found. Set one in Chat settings before
            compiling.
          </div>
        )}

        <div className="add-vault-modal__row">
          <label>Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as WikiProvider)}
          >
            {SUPPORTED.map((id) => (
              <option key={id} value={id}>
                {PROVIDERS[id]?.name ?? id}
              </option>
            ))}
          </select>
        </div>

        <div className="add-vault-modal__row">
          <label>Vault</label>
          {existingVaults.length > 0 && (
            <div className="add-vault-modal__mode">
              <label>
                <input
                  type="radio"
                  checked={vaultMode === 'existing'}
                  onChange={() => setVaultMode('existing')}
                />
                Existing
              </label>
              <label>
                <input
                  type="radio"
                  checked={vaultMode === 'new'}
                  onChange={() => setVaultMode('new')}
                />
                New
              </label>
            </div>
          )}
          {vaultMode === 'existing' && existingVaults.length > 0 ? (
            <select
              value={vaultName}
              onChange={(e) => setVaultName(e.target.value)}
            >
              {existingVaults.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              placeholder="vault-name"
              value={newVaultName}
              onChange={(e) => setNewVaultName(e.target.value)}
            />
          )}
        </div>

        <div className="add-vault-modal__row">
          <label>Files ({files.length} selected)</label>
          <div
            className={`add-vault-modal__drop${dragActive ? ' add-vault-modal__drop--active' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
          >
            {files.length === 0
              ? 'Drop files or a folder here, or pick below'
              : files.map((f) => f.name).join(', ')}
          </div>
          <div className="add-vault-modal__pickers">
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              Browse files…
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
            >
              Browse folder…
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => handleFiles(e.target.files)}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            // @ts-expect-error webkitdirectory is non-standard but widely supported
            webkitdirectory=""
            directory=""
            style={{ display: 'none' }}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {(progress.length > 0 || error) && (
          <div className="add-vault-modal__progress">
            {progress.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            {error && (
              <div className="add-vault-modal__progress-error">{error}</div>
            )}
          </div>
        )}

        <div className="add-vault-modal__actions">
          <button onClick={onClose} disabled={running}>
            Close
          </button>
          <button
            className="primary"
            onClick={handleSubmit}
            disabled={!submittable}
          >
            {running ? 'Compiling…' : hasAttempted ? 'Retry' : 'Compile'}
          </button>
        </div>
      </div>
    </div>
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

function formatEvent(ev: WikiCompileEvent): string {
  if (ev.kind === 'stage_start') return `[${ev.phase}] ▶ ${ev.message}`;
  if (ev.kind === 'stage_progress') {
    const tag = ev.total ? `[${ev.current}/${ev.total}]` : '';
    return `  ${tag} ${ev.message}`;
  }
  if (ev.kind === 'stage_stop') return `[${ev.phase}] ✓ ${ev.message}`;
  if (ev.kind === 'done') return `✓ ${ev.message}`;
  return `✗ ${ev.message}`;
}
