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

export function GitHubIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function GitLabIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 380 380" fill="currentColor">
      <path d="M190 353.9L131.1 172.8h117.8L190 353.9z" opacity="0.85" />
      <path d="M190 353.9L131.1 172.8H15.6L190 353.9z" opacity="0.7" />
      <path
        d="M15.6 172.8L0.4 219.5c-1.4 4.3 0.1 9 3.8 11.7L190 353.9 15.6 172.8z"
        opacity="0.55"
      />
      <path
        d="M15.6 172.8h115.5L87.6 26.5c-1.6-4.9-8.5-4.9-10.1 0L15.6 172.8z"
        opacity="0.85"
      />
      <path d="M190 353.9l58.9-181.1h115.5L190 353.9z" opacity="0.7" />
      <path
        d="M364.4 172.8l15.2 46.7c1.4 4.3-0.1 9-3.8 11.7L190 353.9l174.4-181.1z"
        opacity="0.55"
      />
      <path
        d="M364.4 172.8H248.9l43.5-146.3c1.6-4.9 8.5-4.9 10.1 0l61.9 146.3z"
        opacity="0.85"
      />
    </svg>
  );
}

export function BitbucketIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor">
      <path d="M2.278 2.133a1.07 1.07 0 00-1.07 1.236l4.058 24.637a1.45 1.45 0 001.417 1.195h19.1a1.07 1.07 0 001.07-.903l4.058-24.93a1.07 1.07 0 00-1.07-1.236zm16.7 17.757h-6.1l-1.647-8.613h9.2z" />
    </svg>
  );
}

export function AzureDevOpsIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M15 3.622v8.512L11.5 15l-5.425-1.975v1.958L3.004 10.97l8.951.7V4.005L15 3.622zm-2.984.428L6.994 1v2.001L2.382 4.356 1 6.13v4.029l1.978.873V5.869l9.038-1.819z" />
    </svg>
  );
}
