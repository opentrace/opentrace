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

/**
 * Job execution layer types.
 *
 * Proto types (JobEvent, JobPhase, JobEventKind, JobResult, ProgressDetail)
 * are re-exported from the generated proto code. UI-specific abstractions
 * (JobMessage, JobService, JobStream) are defined here.
 */

export {
  JobPhase,
  JobEventKind,
  type JobEvent,
  type JobResult,
  type ProgressDetail,
} from '../gen/opentrace/v1/agent_service';

import type { JobEvent } from '../gen/opentrace/v1/agent_service';

// --- Job messages (what to do) ---

export type JobMessage =
  | IndexRepoMessage
  | IndexDirectoryMessage
  | ImportFileMessage;

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

export interface ImportFileMessage {
  type: 'import-file';
  file: File;
  name: string;
}

// --- Stream + Service interfaces ---

export interface JobStream extends AsyncIterable<JobEvent> {
  cancel(): void;
}

export interface JobService {
  startJob(message: JobMessage): Promise<JobStream>;
}
