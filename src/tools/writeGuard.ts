import type { Bridge } from "../bridge.js";
import { writeNotSupportedError, writeSupported } from "../layout.js";
import type { WireMethod } from "../types/wire.js";

/**
 * Refuses a write tool's call, dry run included, when the connected page's
 * Plugin API contract does not support the methods it would call. Runs
 * before the tool previews or snapshots anything. The bridge checks
 * again in the same operation as each write, and the page once more in the
 * same turn as the call, so this check only spares the user a preview of a
 * change that cannot be made.
 */
export async function assertWritesSupported(
  bridge: Pick<Bridge, "apiContract">,
  methods: readonly WireMethod[],
): Promise<void> {
  const contract = await bridge.apiContract();
  for (const method of methods) {
    if (!writeSupported(contract, method)) throw writeNotSupportedError(method);
  }
}
