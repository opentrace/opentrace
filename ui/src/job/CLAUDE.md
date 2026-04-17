# Job Service

Bridge between UI job requests and the browser pipeline. Manages job lifecycle, event streaming, and cancellation.

## Files

```
types.ts              — JobMessage union, JobService interface, JobStream
browserJobService.ts  — Implements JobService using pipeline stages + loader registry
eventChannel.ts       — AsyncIterable event stream (push/pull bridge)
useJobStream.ts       — React hook: job state + events for the UI
context.tsx           — React JobServiceContext provider
```

## Execution Flow

1. UI calls `jobService.submit(message)` with a `JobMessage`:
   - `index-repo` — clone from GitHub/GitLab URL
   - `index-directory` — local `FileList` (drag-and-drop / file picker)
   - `import-file` — pre-built export archive (`.parquet.zip`)
   - `connect-server` — switch to `ServerGraphStore` mode (no pipeline run)

2. Service resolves the appropriate loader (git, filesystem, HTTP)
3. Runs the concurrent pipeline (6 stages from `components/pipeline/`)
4. Emits `PipelineEvent` per stage transition via `EventChannel`
5. Accumulates `ImportBatchRequest` → flushes to store
6. Streams `JobEvent` back to UI (consumed via `useJobStream` hook)

## EventChannel

`EventChannel<T>` is a push/pull bridge — producers call `channel.push(event)`, consumers `for await (const event of channel)`. It buffers events when the consumer is behind. Call `channel.close()` to signal completion.

This is the backbone of UI progress updates — `IndexingProgress` component reads from the channel to show per-stage counts.

## Cancellation

Job cancellation is **cooperative**:
- The `JobStream.cancel()` method sets an `AbortSignal`
- Pipeline stages check `ctx.cancelled` (derived from the signal) **between files**
- Long tree-sitter parses on individual files **cannot be interrupted mid-parse**
- After cancellation, the pipeline drains cleanly (no partial writes)

This means cancel latency is bounded by the longest single file's parse time — typically <1s, but pathologically large generated files can take longer.

## React Integration

```typescript
const { stream, submit, state } = useJobStream();
// state: 'idle' | 'running' | 'done' | 'error'
// stream: AsyncIterable<JobEvent>
// submit(msg: JobMessage): void
```

`useJobStream` manages job lifecycle state and exposes the event stream for rendering. Only one job runs at a time — submitting while running is a no-op (enforced by state check, not queuing).

## Pitfalls

- **One-job-at-a-time.** No queue, no concurrent jobs. If you need to re-index, wait for the current job to finish or cancel it first.
- **`connect-server` is not a pipeline job.** It reconfigures the store without running extraction — don't look for pipeline events from it.
- **EventChannel buffer grows unbounded.** If the consumer hangs (e.g., a React re-render blocks the iteration), events queue in memory. In practice this is fine (events are small), but don't buffer binary data through it.
