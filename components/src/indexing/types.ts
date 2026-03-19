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

// Stage progress
export type StageStatus = 'pending' | 'active' | 'completed';

export interface StageState {
  status: StageStatus;
  current: number;
  total: number;
  message: string;
  format?: 'count' | 'bytes'; // default: 'count'
}

// Overall indexing state (only what IndexingProgress reads)
export interface IndexingState {
  status: 'idle' | 'running' | 'persisted' | 'enriching' | 'done' | 'error';
  nodesCreated: number;
  relationshipsCreated: number;
  error: string | null;
  stages: Record<string, StageState>;
}

// Stage configuration (consumer defines order + labels)
export interface StageConfig {
  key: string;
  label: string;
}

// Provider type
export type Provider = 'github' | 'gitlab' | 'bitbucket' | 'azuredevops';

// Job messages (what to index)
export interface IndexRepoMessage {
  type: 'index-repo';
  repoUrl: string;
  token?: string;
  ref?: string;
}

export interface IndexDirectoryMessage {
  type: 'index-directory';
  files: FileList;
  name: string;
}

export type JobMessage = IndexRepoMessage | IndexDirectoryMessage;

// Indexed repo (duplicate detection)
export interface IndexedRepo {
  name: string;
  url: string;
}

// Component props
export interface AddRepoModalProps {
  onClose: () => void;
  onSubmit: (message: JobMessage) => void;
  dismissable?: boolean;
  indexedRepos?: IndexedRepo[];
}

export interface IndexingProgressProps {
  state: IndexingState;
  /** Ordered stage definitions — determines display order and labels */
  stages: StageConfig[];
  provider: Provider | null;
  onClose: () => void;
  onCancel: () => void;
  onMinimize?: () => void;
}
