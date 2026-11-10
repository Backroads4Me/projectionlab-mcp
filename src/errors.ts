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

/**
 * A whole-section or restore payload that still holds `[REDACTED]` under a
 * secret-named key came from a redacted read; writing it back would store the
 * sentinel in the user's data. Names the offending dot paths.
 */
export function redactedSecretsError(
  payloadName: string,
  paths: string[],
): ProjectionLabError {
  return new ProjectionLabError(
    "INVALID_INPUT",
    `${payloadName} contains redacted secret values at: ${paths.join(", ")}`,
    "These values were hidden by the read that produced this payload, so it cannot be written back. " +
      "Supply the real values, or change single fields with projectionlab_update_plan_event or " +
      "projectionlab_update_plan_settings, which patch by path and never round-trip hidden values.",
  );
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
