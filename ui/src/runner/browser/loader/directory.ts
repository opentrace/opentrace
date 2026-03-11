/**
 * Local directory loader — reads files from a browser `<input webkitdirectory>`.
 *
 * Each File in the FileList has a `webkitRelativePath` like "rootDir/src/main.ts".
 * We strip the common root prefix, filter by exclusions and size, then read
 * contents with bounded concurrency for memory safety.
 */

import { MAX_FILE_SIZE } from "./constants";
import { BLOB_CONCURRENCY, isExcludedDir, runWithConcurrency, type FetchProgress } from "./shared";
import type { RepoLoader, LoaderInput, LoaderCallOptions } from "./loaderInterface";
import type { RepoFile, RepoTree } from "../types";

/**
 * Read a FileList (from `<input webkitdirectory>`) into a RepoTree.
 */
export async function readDirectoryFiles(
  files: FileList,
  name: string,
  options: { signal?: AbortSignal; onProgress?: (progress: FetchProgress) => void } = {},
): Promise<RepoTree> {
  const { signal, onProgress } = options;

  onProgress?.({ phase: "tree", current: 0, total: 1 });

  // Determine the common root prefix from the first file
  const firstFile = files[0];
  let rootPrefix = "";
  if (firstFile?.webkitRelativePath) {
    const firstSlash = firstFile.webkitRelativePath.indexOf("/");
    if (firstSlash >= 0) {
      rootPrefix = firstFile.webkitRelativePath.slice(0, firstSlash + 1);
    }
  }

  // Filter eligible files
  interface EligibleFile {
    file: File;
    relPath: string;
  }

  const eligible: EligibleFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (signal?.aborted) break;

    const fullPath = file.webkitRelativePath || file.name;
    const relPath = rootPrefix && fullPath.startsWith(rootPrefix)
      ? fullPath.slice(rootPrefix.length)
      : fullPath;

    if (!relPath) continue;

    // Skip oversized files
    if (file.size > MAX_FILE_SIZE) continue;

    // Skip excluded directories
    const parts = relPath.split("/");
    if (isExcludedDir(parts)) continue;

    eligible.push({ file, relPath });
  }

  onProgress?.({ phase: "tree", current: 1, total: 1 });

  // Read file contents with bounded concurrency
  const result: RepoFile[] = [];
  let completed = 0;

  await runWithConcurrency(eligible, BLOB_CONCURRENCY, async ({ file, relPath }) => {
    if (signal?.aborted) return;

    const content = await file.text();
    result.push({
      path: relPath,
      content,
      sha: "",
      size: file.size,
    });

    completed++;
    onProgress?.({
      phase: "blobs",
      current: completed,
      total: eligible.length,
      fileName: relPath,
    });
  });

  return {
    owner: "local",
    repo: name,
    ref: "local",
    url: undefined,
    files: result,
  };
}

// ---------------------------------------------------------------------------
// RepoLoader implementation
// ---------------------------------------------------------------------------

export const directoryLoader: RepoLoader = {
  name: "directory",

  canHandle(input: LoaderInput): boolean {
    return input.kind === "directory";
  },

  async load(input: LoaderInput, options: LoaderCallOptions): Promise<RepoTree> {
    if (input.kind !== "directory") throw new Error("Directory loader requires a directory input");
    return readDirectoryFiles(input.files, input.name, {
      signal: options.signal,
      onProgress: options.onProgress,
    });
  },
};
