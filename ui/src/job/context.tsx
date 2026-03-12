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

export function useJobService(): JobService {
  const ctx = use(JobServiceContext);
  if (!ctx) {
    throw new Error('useJobService() must be used within <JobServiceProvider>');
  }
  return ctx;
}
