import { enumRefusalError } from "./dataModel.js";
import { ProjectionLabError } from "./errors.js";
import type { PlanObj } from "./plans.js";
import { isSecretFieldName } from "./redact.js";

export interface AddressableValue {
  path: string;
  type: string;
  value: unknown;
  redacted?: boolean;
}

export interface PathValueChange {
  before: unknown;
  after: unknown;
}

export interface PathPatchContext {
  label: string;
  discoveryTool: string;
  example: string;
}

export interface AddressableValueOptions {
  expandArrayPaths?: ReadonlySet<string>;
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * What the stored container holds at a compared path. The absent case covers
 * everything with nothing to compare against: a new key, an element past the
 * end of the stored array, or a stored value of another kind.
 */
type StoredValue = { present: true; value: unknown } | { present: false };

const ABSENT: StoredValue = { present: false };

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is PlanObj {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isContainer(value: unknown): value is PlanObj | unknown[] {
  return isPlainObject(value) || Array.isArray(value);
}

function containerValue(
  container: PlanObj | unknown[],
  key: string,
): unknown {
  return Array.isArray(container) ? container[Number(key)] : container[key];
}

/**
 * Flatten an object into addressable leaf values. Arrays remain atomic unless
 * their exact path is explicitly expanded.
 */
export function listAddressableValues(
  data: unknown,
  prefix = "",
  options: AddressableValueOptions = {},
): AddressableValue[] {
  if (Array.isArray(data)) {
    if (!prefix) return [];
    const values: AddressableValue[] = [
      { path: prefix, type: "array", value: data },
    ];
    if (!options.expandArrayPaths?.has(prefix)) return values;
    for (let index = 0; index < data.length; index++) {
      const path = `${prefix}.${index}`;
      const value = data[index];
      if (isPlainObject(value) && Object.keys(value).length > 0) {
        values.push(...listAddressableValues(value, path, options));
      } else if (Array.isArray(value)) {
        values.push({ path, type: "array", value });
      } else {
        values.push({ path, type: valueType(value), value });
      }
    }
    return values;
  }
  if (!isPlainObject(data)) {
    if (!prefix) return [];
    return [{ path: prefix, type: valueType(data), value: data }];
  }

  const values: AddressableValue[] = [];
  for (const key of Object.keys(data).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = data[key];
    if (isSecretFieldName(key)) {
      values.push({
        path,
        type: valueType(value),
        value: "[REDACTED]",
        redacted: true,
      });
      continue;
    }
    if (
      (isPlainObject(value) && Object.keys(value).length > 0) ||
      Array.isArray(value)
    ) {
      values.push(...listAddressableValues(value, path, options));
    } else {
      values.push({ path, type: valueType(value), value });
    }
  }
  return values;
}

function parsePath(path: string, context: PathPatchContext): string[] {
  const parts = path.split(".");
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        UNSAFE_PATH_SEGMENTS.has(part) ||
        isSecretFieldName(part),
    )
  ) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `Invalid ${context.label} path "${path}"`,
      `Use a dot path returned by ${context.discoveryTool}`,
    );
  }
  return parts;
}

function assertCompatibleType(
  path: string,
  current: unknown,
  incoming: unknown,
  context: PathPatchContext,
): void {
  if (current === null) return;
  const currentType = valueType(current);
  const incomingType = valueType(incoming);
  if (currentType !== incomingType) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `${context.label[0].toUpperCase()}${context.label.slice(1)} "${path}" expects ${currentType}, received ${incomingType}`,
      `Fetch the current value with ${context.discoveryTool} and supply the same JSON type`,
    );
  }
}

function replaceAtPath(
  root: PlanObj | unknown[],
  parts: string[],
  incoming: unknown,
  fullPath: string,
  context: PathPatchContext,
): PlanObj | unknown[] {
  const [head, ...tail] = parts;
  // "length" is an own property of arrays, so hasOwnProperty alone would let
  // a leaf patch resize the array through copy[Number("length")].
  if (Array.isArray(root) && !/^(0|[1-9]\d*)$/.test(head)) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `Array segment "${head}" in ${context.label} path "${fullPath}" is not an index`,
      `Use a numeric array index returned by ${context.discoveryTool}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(root, head)) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `Unknown ${context.label} path "${fullPath}"`,
      `Only existing paths returned by ${context.discoveryTool} can be changed`,
    );
  }
  if (tail.length === 0) {
    const current = root[head as keyof typeof root];
    assertCompatibleType(fullPath, current, incoming, context);
    if (Array.isArray(root)) {
      const copy = root.slice();
      copy[Number(head)] = incoming;
      return copy;
    }
    return { ...root, [head]: incoming };
  }

  const child = root[head as keyof typeof root];
  if (!isContainer(child)) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `${context.label[0].toUpperCase()}${context.label.slice(1)} path "${fullPath}" traverses a non-object value`,
      `Use a complete dot path returned by ${context.discoveryTool}`,
    );
  }
  const replacement = replaceAtPath(child, tail, incoming, fullPath, context);
  if (Array.isArray(root)) {
    const copy = root.slice();
    copy[Number(head)] = replacement;
    return copy;
  }
  return {
    ...root,
    [head]: replacement,
  };
}

/**
 * The value stored at a dot path. Reading a path never fails: an unknown path
 * is `ABSENT`, so everything written under it counts as changed, and
 * `replaceAtPath` is what refuses it.
 */
function readStoredPath(data: unknown, parts: readonly string[]): StoredValue {
  let current = data;
  for (const part of parts) {
    if (
      !isContainer(current) ||
      !Object.prototype.hasOwnProperty.call(current, part)
    ) {
      return ABSENT;
    }
    current = containerValue(current, part);
  }
  return { present: true, value: current };
}

/** The stored counterpart of one key inside a compared value. */
function storedCounterpart(stored: StoredValue, key: string): StoredValue {
  if (!stored.present || !isContainer(stored.value)) return ABSENT;
  if (!Object.prototype.hasOwnProperty.call(stored.value, key)) return ABSENT;
  return { present: true, value: containerValue(stored.value, key) };
}

/**
 * Refusal for a value a write sets outside an observed enum's choices, where
 * `stored` is what the container holds at the same joined path. A whole object
 * or array is walked and each leaf is compared, so `yearlyChange.type` is
 * enforced whether the caller addressed that leaf or sent the container around
 * it. Array elements are addressed by numeric index, the syntax `parsePath`
 * accepts and the registry wildcards match, so a `criteria.*.type` entry
 * matches `criteria.0.type`.
 *
 * Only a leaf whose value the write actually changes is refused. A whole-object
 * write carries the sibling values it did not come to change, so an out-of-list
 * value the plan already holds rides through untouched while the field the
 * caller came for is written; moving that same value to another out-of-list
 * value is still refused. A leaf with no stored counterpart (a new key, an
 * element past the end of the stored array, a stored value of another kind)
 * counts as changed and is checked.
 */
function enumRefusalForValue(
  scope: string,
  path: string,
  value: unknown,
  stored: StoredValue,
): ProjectionLabError | undefined {
  if (stored.present && storedValueMatches(value, stored.value)) {
    return undefined;
  }
  const refusal = enumRefusalError(scope, path, value);
  if (refusal) return refusal;
  if (!isContainer(value)) return undefined;
  for (const key of Object.keys(value)) {
    const nested = enumRefusalForValue(
      scope,
      `${path}.${key}`,
      containerValue(value, key),
      storedCounterpart(stored, key),
    );
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Refusal for a field a write adds, where the container holds nothing at
 * `path` yet: every leaf of the new value counts as changed, arrays included.
 */
export function enumRefusalForNewValue(
  scope: string,
  path: string,
  value: unknown,
): ProjectionLabError | undefined {
  return enumRefusalForValue(scope, path, value, ABSENT);
}

/**
 * Whether writing `value` at `path` of `data` would change anything, compared
 * by value rather than by JSON text. A patch leaf that already holds this
 * value is not a write of that value, so the observed enums do not apply to
 * it.
 */
export function pathValueUnchanged(
  data: unknown,
  path: string,
  value: unknown,
): boolean {
  const stored = readStoredPath(data, path.split("."));
  return stored.present && storedValueMatches(value, stored.value);
}

/**
 * Apply path-addressed changes immutably. Paths must already exist and values
 * must retain their JSON type. When `scope` names a group in the data model
 * registry (a settings section, event section, or Current Finances
 * collection), a string value outside an observed
 * enum's choices is refused with INVALID_INPUT, at the addressed path and at
 * every path nested inside a whole-object or whole-array value. A leaf is
 * checked only when the write changes it, so an out-of-list value the stored
 * object already holds does not block writing the fields beside it.
 */
export function applyExistingPathChanges(
  data: unknown,
  incoming: Record<string, unknown>,
  context: PathPatchContext,
  scope?: string,
): {
  updated: PlanObj;
  changes: Record<string, PathValueChange>;
} {
  if (!isPlainObject(data)) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `The selected ${context.label} container is not an object`,
      `Inspect it with ${context.discoveryTool}`,
    );
  }
  if (Object.keys(incoming).length === 0) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `At least one ${context.label} change is required`,
      `Supply changes such as ${context.example}`,
    );
  }

  const paths = Object.keys(incoming).sort();
  for (let i = 0; i < paths.length; i++) {
    const parent = paths[i];
    const child = paths[i + 1];
    if (child?.startsWith(`${parent}.`)) {
      throw new ProjectionLabError(
        "INVALID_INPUT",
        `Overlapping ${context.label} paths "${parent}" and "${child}"`,
        "Change either the parent value or its nested paths in one request, not both",
      );
    }
  }

  // Every refusal is raised before anything is applied, so a later path cannot
  // leave a half-patched container.
  const checked: { path: string; parts: string[]; after: unknown }[] = [];
  for (const [path, after] of Object.entries(incoming)) {
    const parts = parsePath(path, context);
    if (scope !== undefined) {
      const refusal = enumRefusalForValue(
        scope,
        path,
        after,
        readStoredPath(data, parts),
      );
      if (refusal) throw refusal;
    }
    checked.push({ path, parts, after });
  }

  let updated = data;
  const changes: Record<string, PathValueChange> = {};
  for (const { path, parts, after } of checked) {
    let before: unknown = data;
    for (const part of parts) {
      if (
        !isContainer(before) ||
        !Object.prototype.hasOwnProperty.call(before, part)
      ) {
        throw new ProjectionLabError(
          "INVALID_INPUT",
          `Unknown ${context.label} path "${path}"`,
          `Only existing paths returned by ${context.discoveryTool} can be changed`,
        );
      }
      before = containerValue(before, part);
    }
    updated = replaceAtPath(updated, parts, after, path, context) as PlanObj;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes[path] = { before, after };
    }
  }
  return { updated, changes };
}

/** A patched path whose stored value does not match what the write sent. */
export interface PathChangeMismatch {
  path: string;
  /** The value the caller asked to store. */
  expected: unknown;
  /** The value the plan holds now; `undefined` when the path is absent. */
  stored: unknown;
  /**
   * `absent` means the path disappeared, `shape` means the stored value is a
   * different kind of value than the one sent, and `value` means it is the
   * right kind holding different contents.
   */
  reason: "absent" | "shape" | "value";
}

/**
 * Match a stored value against the value a write submitted.
 *
 * ProjectionLab rewrites objects as it saves them: it emits keys in its own
 * order and fills in defaults the caller never sent. Comparing JSON text
 * therefore rejects writes that did land, so every key and array element the
 * caller sent must be stored with an equal value while keys the app adds on
 * its own are allowed. A key that vanishes, changes type or changes value
 * still fails.
 */
function storedValueMatches(expected: unknown, stored: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(stored)) return false;
    return Object.entries(expected).every(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(stored, key) &&
        storedValueMatches(value, stored[key]),
    );
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(stored) &&
      stored.length === expected.length &&
      expected.every((item, index) => storedValueMatches(item, stored[index]))
    );
  }
  return expected === stored;
}

/**
 * Report the patched paths the stored object does not carry.
 *
 * The reason splits the causes a boolean cannot: a path the app dropped, a
 * value it changed the type of, and a value whose contents differ.
 */
export function findPathChangeMismatches(
  data: unknown,
  expected: Record<string, PathValueChange>,
  context: PathPatchContext,
): PathChangeMismatch[] {
  const entries = Object.entries(expected);
  if (!isPlainObject(data)) {
    return entries.map(([path, change]) => ({
      path,
      expected: change.after,
      stored: undefined,
      reason: "absent" as const,
    }));
  }

  const mismatches: PathChangeMismatch[] = [];
  for (const [path, change] of entries) {
    let actual: unknown = data;
    let present = true;
    for (const part of parsePath(path, context)) {
      if (
        !isContainer(actual) ||
        !Object.prototype.hasOwnProperty.call(actual, part)
      ) {
        present = false;
        break;
      }
      actual = containerValue(actual, part);
    }
    if (!present) {
      mismatches.push({
        path,
        expected: change.after,
        stored: undefined,
        reason: "absent",
      });
      continue;
    }
    if (storedValueMatches(change.after, actual)) continue;
    const sameKind =
      Array.isArray(change.after) === Array.isArray(actual) &&
      change.after !== null &&
      actual !== null &&
      typeof change.after === typeof actual;
    mismatches.push({
      path,
      expected: change.after,
      stored: actual,
      reason: sameKind ? "value" : "shape",
    });
  }
  return mismatches;
}

export function pathChangesApplied(
  data: unknown,
  expected: Record<string, PathValueChange>,
  context: PathPatchContext,
): boolean {
  if (!isPlainObject(data)) return false;
  return findPathChangeMismatches(data, expected, context).length === 0;
}
