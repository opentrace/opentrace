/**
 * Browser-based JobService implementation.
 *
 * Wraps IndexingManager + GraphStore behind the JobService interface.
 * The manager's callbacks push events into an EventChannel, which the
 * consumer reads via `for await (const event of stream)`.
 */

import { IndexingManager } from "../runner/browser";
import type { IndexPhase, LoaderInput } from "../runner/browser";
import { JobEventKind, JobPhase } from "../gen/opentrace/v1/agent_service";
import type { JobEvent } from "../gen/opentrace/v1/agent_service";
import type { GraphStore } from "../store/types";
import { EventChannel } from "./eventChannel";
import type { JobMessage, JobService, JobStream } from "./types";

/** Map IndexingManager's string phases to proto JobPhase enum values. */
const PHASE_MAP: Record<IndexPhase, JobPhase> = {
  initializing: JobPhase.JOB_PHASE_INITIALIZING,
  fetching: JobPhase.JOB_PHASE_FETCHING,
  parsing: JobPhase.JOB_PHASE_PARSING,
  resolving: JobPhase.JOB_PHASE_RESOLVING,
  enriching: JobPhase.JOB_PHASE_ENRICHING,
  summarizing: JobPhase.JOB_PHASE_SUMMARIZING,
  embedding: JobPhase.JOB_PHASE_EMBEDDING,
  submitting: JobPhase.JOB_PHASE_SUBMITTING,
  done: JobPhase.JOB_PHASE_DONE,
};

function toProtoPhase(phase: IndexPhase): JobPhase {
  return PHASE_MAP[phase] ?? JobPhase.JOB_PHASE_UNSPECIFIED;
}

/** Build a default empty JobEvent shell (proto fields are always present). */
function emptyEvent(): JobEvent {
  return {
    kind: JobEventKind.JOB_EVENT_KIND_UNSPECIFIED,
    phase: JobPhase.JOB_PHASE_UNSPECIFIED,
    message: "",
    result: undefined,
    errors: [],
    detail: undefined,
    nodes: [],
    relationships: [],
  };
}

export class BrowserJobService implements JobService {
  private store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  async startJob(message: JobMessage): Promise<JobStream> {
    // Map the job message to a LoaderInput for the IndexingManager
    let input: LoaderInput;
    if (message.type === "index-repo") {
      input = {
        kind: "url",
        url: message.repoUrl,
        token: message.token,
        ref: message.ref,
      };
    } else if (message.type === "index-directory") {
      input = {
        kind: "directory",
        files: message.files,
        name: message.name,
      };
    } else {
      throw new Error(`Unsupported job type: ${(message as { type: string }).type}`);
    }

    const channel = new EventChannel<JobEvent>();
    let manager: IndexingManager | null = null;

    manager = new IndexingManager(
      {
        onProgress: (phase, msg, detail) => {
          channel.push({
            ...emptyEvent(),
            kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
            phase: toProtoPhase(phase),
            message: msg,
            detail: {
              current: detail.current,
              total: detail.total,
              fileName: detail.fileName ?? "",
              nodesCreated: detail.nodesCreated ?? 0,
              relationshipsCreated: detail.relationshipsCreated ?? 0,
            },
          });
        },
        onStageComplete: (phase, msg) => {
          channel.push({
            ...emptyEvent(),
            kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
            phase: toProtoPhase(phase),
            message: msg,
          });
        },
        onPersisted: (nodesCreated, relationshipsCreated) => {
          channel.push({
            ...emptyEvent(),
            kind: JobEventKind.JOB_EVENT_KIND_GRAPH_READY,
            result: { nodesCreated, relationshipsCreated, reposProcessed: 0 },
          });
        },
        onDone: (summary) => {
          channel.push({
            ...emptyEvent(),
            kind: JobEventKind.JOB_EVENT_KIND_DONE,
            phase: JobPhase.JOB_PHASE_DONE,
            result: {
              nodesCreated: summary.nodesCreated,
              relationshipsCreated: summary.relationshipsCreated,
              reposProcessed: 0,
            },
            errors: summary.errors,
          });
          channel.close();
        },
        onError: (msg) => {
          channel.push({
            ...emptyEvent(),
            kind: JobEventKind.JOB_EVENT_KIND_ERROR,
            message: msg,
            errors: [msg],
          });
          channel.close();
        },
      },
      this.store,
    );

    await manager.start(input);

    return {
      [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
      cancel() {
        manager?.cancel();
        channel.close();
      },
    };
  }
}
