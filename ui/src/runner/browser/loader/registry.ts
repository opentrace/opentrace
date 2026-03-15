/**
 * Ordered loader registry.
 *
 * The manager iterates this array and delegates to the first loader
 * whose `canHandle()` returns true. Order matters:
 *  - directoryLoader first (checks kind === "directory", never conflicts with URL)
 *  - gitlabLoader before githubLoader (GitLab URLs are more specific)
 *  - azuredevopsLoader before githubLoader (Azure DevOps URLs are more specific)
 *  - bitbucketLoader before githubLoader
 */

import type { RepoLoader } from './loaderInterface';
import { directoryLoader } from './directory';
import { gitlabLoader } from './gitlab';
import { azuredevopsLoader } from './azuredevops';
import { bitbucketLoader } from './bitbucket';
import { githubLoader } from './github';

export const loaderRegistry: readonly RepoLoader[] = [
  directoryLoader,
  gitlabLoader,
  azuredevopsLoader,
  bitbucketLoader,
  githubLoader,
];
