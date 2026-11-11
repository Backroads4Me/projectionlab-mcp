import type { ExportedData } from "./types/projectionlab.js";

export interface ConnectionStatus {
  browser: boolean;
  pageLoaded: boolean;
  apiAvailable: boolean;
  apiKeyValid: boolean;
  /** Connected executor's identity, "extension/<version>" or "bootstrap/<version>". */
  executor?: string;
  errors: string[];
}

/**
 * Surface for reaching window.projectionlabPluginAPI in a live ProjectionLab
 * page. Implemented by ExtensionBridge, which relays over a localhost
 * WebSocket to a browser extension or bootstrap snippet. Tools, resources,
 * prompts, and the snapshot manager depend only on this interface.
 */
export interface Bridge {
  checkConnection(): Promise<ConnectionStatus>;
  describePluginApi(): Promise<Record<string, string>>;
  /** Full export, served from a short-lived cache unless `fresh` is true. */
  exportData(opts?: { fresh?: boolean }): Promise<ExportedData>;
  updateAccount(
    accountId: string,
    data: Record<string, unknown>,
    force?: boolean,
  ): Promise<void>;
  restoreCurrentFinances(state: unknown): Promise<void>;
  restorePlans(plans: unknown[]): Promise<void>;
  /**
   * Writes `plans` unless a plan was added, removed, or saved since `read`
   * was taken, in which case it throws PLAN_CONFLICT and writes nothing. The
   * re-read and the write are atomic: no other operation runs between them.
   */
  restorePlansIfUnchanged(read: unknown[], plans: unknown[]): Promise<void>;
  restoreProgress(progress: unknown): Promise<void>;
  restoreSettings(settings: unknown): Promise<void>;
  invalidateCache(): void;
  close(): Promise<void>;
}
