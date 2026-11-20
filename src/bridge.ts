import type { ApiContract } from "./layout.js";
import type { ExportedData } from "./types/projectionlab.js";

export interface ConnectionStatus {
  browser: boolean;
  pageLoaded: boolean;
  apiAvailable: boolean;
  apiKeyValid: boolean;
  /** Connected executor's identity, "extension/<version>" or "bootstrap/<version>". */
  executor?: string;
  /** Plugin API contract the page offers (src/layout.ts), once the API is available. */
  apiContract?: ApiContract;
  errors: string[];
  /** Whether the connected executor allows edits (see EditAccess). */
  writesEnabled: boolean;
}

/**
 * Whether the connected executor allows writes: "enabled" while the
 * extension's Enable agent plan edits switch is on, "disabled" while it is
 * off, "unsupported" for an executor that has no switch (the console
 * bootstrap snippet, extension releases without it). Only "enabled" allows a
 * write; the extension also refuses writes in the browser while it is off.
 */
export type EditAccess = "enabled" | "disabled" | "unsupported";

/**
 * Surface for reaching window.projectionlabPluginAPI in a live ProjectionLab
 * page. Implemented by ExtensionBridge, which relays over a localhost
 * WebSocket to a browser extension or bootstrap snippet. Tools, resources,
 * prompts, and the snapshot manager depend only on this interface.
 */
export interface Bridge {
  checkConnection(): Promise<ConnectionStatus>;
  describePluginApi(): Promise<Record<string, string>>;
  /** The Plugin API contract the connected page offers, read fresh; a page
   * on a contract this server does not support is refused. */
  apiContract(): Promise<ApiContract>;
  /** The connected executor's edit access; connects to it first if needed. */
  editAccess(): Promise<EditAccess>;
  /** Full export, served from a short-lived cache unless `fresh` is true. */
  exportData(opts?: { fresh?: boolean }): Promise<ExportedData>;
  /*
   * Every write reads the page's Plugin API contract in the same
   * operation-chain entry as the write, so a write never lands on a page
   * that no longer offers ProjectionLab 5.
   */
  updateAccount(
    accountId: string,
    data: Record<string, unknown>,
    force: boolean | undefined,
  ): Promise<void>;
  restoreCurrentFinances(state: unknown): Promise<void>;
  restorePlans(plans: unknown[]): Promise<void>;
  /**
   * Writes `plans` unless a plan was added, removed, or saved since `read`
   * was taken, in which case it throws PLAN_CONFLICT and writes nothing. The
   * re-read and the write are atomic: no other operation runs between them.
   */
  restorePlansIfUnchanged(read: unknown[], plans: unknown[]): Promise<void>;
  restoreSettings(settings: unknown): Promise<void>;
  invalidateCache(): void;
  close(): Promise<void>;
}
