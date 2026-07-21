export interface ExportedData {
  today?: unknown;
  plans?: unknown[];
  progress?: unknown;
  settings?: unknown;
  [key: string]: unknown;
}

export interface AccountSummary {
  id: string;
  name: string;
  type: string;
  balance: number;
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
  incomeCount: number;
  expenseCount: number;
  milestoneCount: number;
  progressEntryCount: number;
}

export interface FinancialSummary {
  totalNetWorth: number;
  accountsByType: Record<string, { count: number; total: number }>;
  planCount: number;
  plans: PlanSummary[];
  incomeCount: number;
  expenseCount: number;
  milestoneCount: number;
}

export interface Snapshot {
  id: string;
  timestamp: string;
  operation: string;
  sections: string[];
  data: Record<string, unknown>;
}
