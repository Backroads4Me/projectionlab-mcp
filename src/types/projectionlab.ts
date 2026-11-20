
export interface ExportedData {
  plans?: unknown[];
  progress?: unknown;
  settings?: unknown;
  [key: string]: unknown;
}

export interface AccountSummary {
  id: string;
  name: string;
  type: string;
  balance?: number;
  // Asset rows (type "assets", or "real-estate" for real estate) report
  // marketValue and loanBalance instead of balance: ProjectionLab stores an
  // asset's loan in `balance` and its market value in `amount`.
  marketValue?: number;
  loanBalance?: number;
}

export interface PlanSummary {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface SchemaDescription {
  topLevelKeys: Record<string, string>;
  accounts: AccountSummary[];
  plans: PlanSummary[];
  progressEntryCount: number;
}

export interface FinancialSummary {
  scope: "currentFinances";
  projectedOutcomesAvailable: false;
  totalNetWorth: number;
  accountsByType: Record<string, { count: number; total: number }>;
  planCount: number;
  plans: PlanSummary[];
}

export interface Snapshot {
  id: string;
  timestamp: string;
  operation: string;
  sections: string[];
  /** Export layout the data was taken from: "v5" for ProjectionLab 5.
   * Snapshots without one were taken from ProjectionLab 4; rollback and diff
   * refuse them (assertSnapshotLayout in src/layout.ts). */
  layout?: string;
  data: Record<string, unknown>;
}
