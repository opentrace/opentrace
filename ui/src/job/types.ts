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
} from "../gen/opentrace/v1/agent_service";

import type { JobEvent } from "../gen/opentrace/v1/agent_service";

// --- Job messages (what to do) ---

export type JobMessage = IndexRepoMessage | IndexDirectoryMessage;

export interface IndexRepoMessage {
  type: "index-repo";
  repoUrl: string;
  token?: string;
  ref?: string;
}

export interface IndexDirectoryMessage {
  type: "index-directory";
  files: FileList;
  name: string;
}

// --- Stream + Service interfaces ---

export interface JobStream extends AsyncIterable<JobEvent> {
  cancel(): void;
}

export interface JobService {
  startJob(message: JobMessage): Promise<JobStream>;
}
