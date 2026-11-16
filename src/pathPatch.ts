import { enumRefusalError } from "./dataModel.js";
import { ProjectionLabError } from "./errors.js";
import type { ExportLayout } from "./layout.js";
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
 * Refusal for a value a write sets outside an observed enum's choices. A whole
 * object or array is walked and each leaf is checked with the joined path, so
 * `yearlyChange.type` is enforced whether the caller addressed that leaf or
 * sent the container around it. Array elements are addressed by numeric index,
 * the syntax `parsePath` accepts and the registry wildcards match, so a
 * `criteria.*.type` entry matches `criteria.0.type`.
 */
function enumRefusalForValue(
  scope: string,
  path: string,
  value: unknown,
  layout: ExportLayout,
): ProjectionLabError | undefined {
  const refusal = enumRefusalError(scope, path, value, layout);
  if (refusal) return refusal;
  if (!isContainer(value)) return undefined;
  for (const key of Object.keys(value)) {
    const nested = enumRefusalForValue(
      scope,
      `${path}.${key}`,
      containerValue(value, key),
      layout,
    );
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Apply path-addressed changes immutably. Paths must already exist and values
 * must retain their JSON type. When `scope` names a group in the data model
 * registry (a settings section, event section, or Current Finances
 * collection) of the `layout` data model, a string value outside an observed
 * enum's choices is refused with INVALID_INPUT, at the addressed path and at
 * every path nested inside a whole-object or whole-array value.
 */
export function applyExistingPathChanges(
  data: unknown,
  incoming: Record<string, unknown>,
  context: PathPatchContext,
  scope?: string,
  layout: ExportLayout = "v4",
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
      const refusal = enumRefusalForValue(scope, path, after, layout);
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

export function pathChangesApplied(
  data: unknown,
  expected: Record<string, PathValueChange>,
  context: PathPatchContext,
): boolean {
  if (!isPlainObject(data)) return false;
  for (const [path, change] of Object.entries(expected)) {
    let actual: unknown = data;
    for (const part of parsePath(path, context)) {
      if (
        !isContainer(actual) ||
        !Object.prototype.hasOwnProperty.call(actual, part)
      ) {
        return false;
      }
      actual = containerValue(actual, part);
    }
    if (JSON.stringify(actual) !== JSON.stringify(change.after)) return false;
  }
  return true;
}
