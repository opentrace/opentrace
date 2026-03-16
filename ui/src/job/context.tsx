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

import { createContext, use, useMemo, type ReactNode } from 'react';
import { useStore } from '../store';
import { BrowserJobService } from './browserJobService';
import type { JobService } from './types';

const JobServiceContext = createContext<JobService | null>(null);

export function JobServiceProvider({ children }: { children: ReactNode }) {
  const { store } = useStore();

  const jobService = useMemo(() => new BrowserJobService(store), [store]);

  return <JobServiceContext value={jobService}>{children}</JobServiceContext>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useJobService(): JobService {
  const ctx = use(JobServiceContext);
  if (!ctx) {
    throw new Error('useJobService() must be used within <JobServiceProvider>');
  }
  return ctx;
}
