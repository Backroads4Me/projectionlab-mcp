import { config } from "./config.js";

/**
 * Serialize tool output. Compact by default - pretty-printing deeply nested
 * plan JSON costs ~25-40% more tokens for no comprehension gain to a model.
 * Set PL_PRETTY_JSON=true for human-readable output.
 */
export function toJson(value: unknown): string {
  return config.prettyJson
    ? JSON.stringify(value, null, 2)
    : JSON.stringify(value);
}
