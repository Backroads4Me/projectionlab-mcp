import { config } from "./config.js";

/** The stand-in every redacted value carries; shared with the diff engine. */
export const REDACTED = "[REDACTED]";

// Field names whose values are secrets regardless of content. Used only for
// read-only artifacts (exports, resources) - NOT for snapshots, since redacting
// by name could corrupt a later restore.
const SECRET_KEY_PATTERN =
  /^(.*[-_])?(api[-_]?key|plugin[-_]?api[-_]?key|token|auth[-_]?token|authorization|password|passwd|secret|client[-_]?secret)([-_].*)?$/i;

export function isSecretFieldName(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name);
}

/**
 * Dot paths (array indices joined with dots) where a secret-named key holds
 * exactly the `REDACTED` sentinel. A payload built from a redacted read
 * carries these; writing one back would store the sentinel as real data.
 */
export function findRedactedSecretPaths(value: unknown, prefix = ""): string[] {
  const paths: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, at ? `${at}.${i}` : String(i)));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const path = at ? `${at}.${k}` : k;
        if (isSecretFieldName(k) && val === REDACTED) paths.push(path);
        else walk(val, path);
      }
    }
  };
  walk(value, prefix);
  return paths;
}

export interface RedactOptions {
  /**
   * Also redact any field whose *name* looks like a secret (apiKey, token,
   * password, …). Safe for read-only artifacts; leave false for snapshots that
   * may be restored, since it can overwrite legitimate data on rollback.
   */
  byName?: boolean;
}

/**
 * Returns a deep copy of `value` with secrets scrubbed:
 *  - The literal Plugin API key (config.apiKey) is replaced wherever it appears
 *    inside any string (always, restore-safe).
 *  - When `byName` is true, values of secret-named fields are replaced too.
 *
 * Never mutates the input.
 */
export function redactSecrets<T>(value: T, opts: RedactOptions = {}): T {
  const byName = opts.byName ?? false;
  const key = config.apiKey;
  const seen = new WeakSet<object>();

  const scrubString = (s: string): string =>
    key && key.length > 0 && s.includes(key) ? s.split(key).join(REDACTED) : s;

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      if (seen.has(v as object)) return v; // guard cycles
      seen.add(v as object);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = byName && isSecretFieldName(k) ? REDACTED : walk(val);
      }
      return out;
    }
    return v;
  };

  return walk(value) as T;
}
