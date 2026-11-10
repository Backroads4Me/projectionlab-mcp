// Release versions are major.minor.patch triples of non-negative integers.
// Anything else (a leading v, prerelease or build suffixes, extra segments)
// is unparsable, and callers treat unparsable as "say nothing".

function parse(version: string): [number, number, number] | null {
  if (typeof version !== "string") return null;
  const parts = version.split(".");
  if (parts.length !== 3) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d*)$/.test(part)) return null;
    numbers.push(Number(part));
  }
  return [numbers[0], numbers[1], numbers[2]];
}

/**
 * Compare two `major.minor.patch` versions numerically. Returns -1, 0, or 1,
 * or null when either input is not three dot-separated non-negative integers.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}
