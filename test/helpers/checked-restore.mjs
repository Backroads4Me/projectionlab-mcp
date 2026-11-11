// The mock-bridge counterpart of ExtensionBridge.restorePlansIfUnchanged:
// the conflict check followed by the write, through the mock's own
// exportData and restorePlans. Add it to a mock bridge as a method.
//
// dist is imported on first use: its modules read the environment when
// loaded, and tests set the environment after their static imports.

export async function restorePlansIfUnchanged(read, plans) {
  const { assertPlansUnchanged } = await import("../../dist/planVersion.js");
  await assertPlansUnchanged(this, read);
  await this.restorePlans(plans);
}
