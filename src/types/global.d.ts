export {};

declare global {
  interface Window {
    projectionlabPluginAPI: {
      exportData(opts: { key: string }): Promise<Record<string, unknown>>;
      updateAccount(
        id: string,
        data: Record<string, unknown>,
        opts: { key: string; force?: string },
      ): Promise<unknown>;
      restoreCurrentFinances(
        state: unknown,
        opts: { key: string },
      ): Promise<unknown>;
      restorePlans(plans: unknown[], opts: { key: string }): Promise<unknown>;
      restoreProgress(
        progress: unknown,
        opts: { key: string },
      ): Promise<unknown>;
      restoreSettings(
        settings: unknown,
        opts: { key: string },
      ): Promise<unknown>;
      /** Throws if the key is invalid; absent on older app builds. */
      validateApiKey?(params: { key: string }): void;
    };
  }
}
