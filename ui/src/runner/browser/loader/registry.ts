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
