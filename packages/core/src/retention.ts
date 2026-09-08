export interface PruneRunsOptions {
  /** Retain runs updated within this many days; default 30. */
  olderThanDays?: number;
  /** Always retain this many newest runs; default 20. */
  keepLast?: number;
  /** Deletion is opt-in; omission returns a preview. */
  apply?: boolean;
}

export interface RetainedRunCandidate {
  runId: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface PruneRunsResult {
  dryRun: boolean;
  cutoff: string;
  keepLast: number;
  candidates: RetainedRunCandidate[];
  removed: RetainedRunCandidate[];
  skipped: { runId: string; reason: string }[];
}
