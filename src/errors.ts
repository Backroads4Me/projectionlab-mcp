import { redactSecrets } from "./redact.js";

export type ErrorCode =
  | "BROWSER_NOT_READY"
  | "EXTENSION_NOT_CONNECTED"
  | "PAGE_NOT_LOADED"
  | "API_NOT_AVAILABLE"
  | "API_KEY_INVALID"
  | "API_KEY_MISSING"
  | "TIMEOUT"
  | "INVALID_INPUT"
  | "READ_ONLY_MODE"
  | "SNAPSHOT_NOT_FOUND"
  | "PLAN_CONFLICT"
  | "UNKNOWN";

export interface PlError {
  error: ErrorCode;
  message: string;
  suggestion: string;
}

export class ProjectionLabError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly suggestion: string,
  ) {
    super(message);
    this.name = "ProjectionLabError";
  }

  toResult(): PlError {
    return {
      error: this.code,
      message: this.message,
      suggestion: this.suggestion,
    };
  }
}

export function toPlError(err: unknown): PlError {
  if (err instanceof ProjectionLabError) {
    return err.toResult();
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: "UNKNOWN",
    message,
    suggestion: "Check server logs for details",
  };
}

export function errorResult(err: unknown) {
  // An error message can echo request data from the browser executor, so the
  // Plugin API key is scrubbed from it like any other tool output.
  const plErr = redactSecrets(toPlError(err));
  return {
    content: [{ type: "text" as const, text: JSON.stringify(plErr) }],
    isError: true,
  };
}
