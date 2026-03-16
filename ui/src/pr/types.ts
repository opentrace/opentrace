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

/** PR/MR data types shared across GitHub and GitLab clients. */

export interface PRSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  created_at: string;
  updated_at: string;
  base_branch: string;
  head_branch: string;
  additions: number;
  deletions: number;
  draft?: boolean;
}

export interface PRFileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
  previous_path?: string;
}

export interface PRDetail extends PRSummary {
  body: string;
  files: PRFileDiff[];
  comments_count: number;
  review_comments_count: number;
  mergeable?: boolean;
}

export interface PRReviewComment {
  body: string;
  path?: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
}

export interface RepoMeta {
  provider: 'github' | 'gitlab' | 'bitbucket' | 'azuredevops';
  owner: string;
  repo: string;
  host?: string;
  /** Azure DevOps project name (org/project/repo triple). */
  project?: string;
}
