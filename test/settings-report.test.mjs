import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-report-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { formatValue, renderSettingsReport } = await import(
  "../dist/settingsReport.js"
);
const { registerSettingsReportTool } = await import(
  "../dist/tools/settingsReport.js"
);

function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    },
  };
}

/** The v5 fixture with populated settings on both plans. */
function exportWithSettings() {
  const data = v5Export();
  const [main, early] = data.documents.plans;
  main.variables = {
    inflation: 3,
    investmentReturn: 7,
    assumptionsMode: "fixed",
    withholding: { taxDeferred: 10 },
    investmentReturnCustom: [
      { year: 2026, rate: 5 },
      { year: 2035, rate: 4 },
    ],
    notes: "a | b",
    integration: { authToken: "sensitive" },
  };
  main.montecarlo = { inflationMean: 3, inflationStdDev: 1.5 };
  main.withdrawalStrategy = { enabled: false };
  early.variables = {
    inflation: 2.5,
    investmentReturn: 7,
    assumptionsMode: "fixed",
    investmentReturnCustom: [
      { year: 2026, rate: 5 },
      { year: 2035, rate: 4 },
    ],
    notes: "a | b",
  };
  early.montecarlo = { inflationMean: 3, inflationStdDev: 1.5 };
  early.withdrawalStrategy = { enabled: true };
  return data;
}

async function runTool(args, data = exportWithSettings()) {
  const server = fakeServer();
  registerSettingsReportTool(server, {
    async exportData() {
      return data;
    },
  });
  return server.handlers.get("projectionlab_get_settings_report")(args);
}

test("values are formatted by their units", () => {
  assert.equal(formatValue(3.25, "percentage points"), "3.25%");
  assert.equal(formatValue(0.035, "decimal fraction"), "3.5%");
  assert.equal(formatValue(1234567.5, "dollars"), "$1,234,567.5");
  assert.equal(formatValue(-500, "dollars"), "-$500");
  assert.equal(formatValue(2035, "calendar year"), "2035");
  assert.equal(formatValue(true), "On");
  assert.equal(formatValue(false), "Off");
  assert.equal(formatValue(null), "none");
  assert.equal(formatValue(""), "(empty)");
  assert.equal(formatValue([]), "(empty list)");
  assert.equal(
    formatValue([
      { year: 2026, rate: 5 },
      { year: 2035, rate: 4 },
    ]),
    "2026: 5, 2035: 4",
  );
});

test("a one-plan report names settings by label under their app location", async () => {
  const result = await runTool({ planIdentifier: "Main Plan" });
  assert.equal(result.isError, undefined);
  const report = result.content[0].text;

  assert.match(report, /^# Plan settings: Main Plan\n/);
  assert.match(report, /## Assumptions, taxes and estate \(`variables`\)/);
  assert.match(report, /### Plan Settings > Rates \(Fixed mode\)/);
  assert.match(report, /\| Inflation Rate \| 3% \|/);
  assert.match(report, /\| Stock Growth Rate \| 7% \|/);
  assert.match(report, /\| Tax-Deferred Withdrawals \| 10% \|/);
  // Inflation comes before Stock Growth Rate, as in the app.
  assert.ok(report.indexOf("Inflation Rate") < report.indexOf("Stock Growth Rate"));
  // The montecarlo labels are read under their own location.
  assert.match(report, /### Chance of Success > Data Sources > Inflation\n\n\| Setting \| Value \|\n\| --- \| --- \|\n\| Mean \| 3% \|\n\| Std\. Dev\. \| 1\.5% \|/);
  assert.match(report, /\| Textbook Strategy \| Off \|/);
});

test("unlabeled settings close their section by stored path", async () => {
  const report = (await runTool({ planIdentifier: "Main Plan", section: "variables" }))
    .content[0].text;
  const other = report.indexOf("### Other stored settings");
  assert.ok(other > report.indexOf("### Plan Settings > Rates"));
  assert.match(
    report,
    /\| `assumptionsMode`: Return and inflation modeling mode[^|]*\| fixed \|/,
  );
  // A path the data model does not describe stays bare.
  assert.match(report, /\| `notes` \| a \\\| b \|/);
  assert.doesNotMatch(report, /## Chance of Success/);
});

test("a rate schedule is one row, not one per control point", async () => {
  const report = (await runTool({ planIdentifier: "Main Plan" })).content[0].text;
  assert.match(report, /\| `investmentReturnCustom` \| 2026: 5, 2035: 4 \|/);
  assert.doesNotMatch(report, /investmentReturnCustom\.0/);
});

test("cells escape pipes and secret-named fields stay redacted", async () => {
  const report = (await runTool({ planIdentifier: "Main Plan" })).content[0].text;
  assert.match(report, /\| `notes` \| a \\\| b \|/);
  assert.doesNotMatch(report, /sensitive/);
  assert.match(report, /\| `integration\.authToken` \| \[REDACTED\] \|/);
});

test("a two-plan report marks differences and settings only one plan holds", async () => {
  const report = (
    await runTool({ planIdentifier: "Main Plan", comparePlanIdentifier: "Retire Early" })
  ).content[0].text;

  assert.match(report, /^# Plan settings: Main Plan vs Retire Early\n/);
  assert.match(report, /\| Setting \| Main Plan \| Retire Early \| Differs \|/);
  assert.match(report, /\| Inflation Rate \| 3% \| 2\.5% \| \*\*Yes\*\* \|/);
  assert.match(report, /\| Stock Growth Rate \| 7% \| 7% \|  \|/);
  assert.match(report, /\| Tax-Deferred Withdrawals \| 10% \| not set \| \*\*Yes\*\* \|/);
  assert.match(report, /\| Textbook Strategy \| Off \| On \| \*\*Yes\*\* \|/);
  // Equal schedules compare by value, not identity.
  assert.match(report, /\| `investmentReturnCustom` \| 2026: 5, 2035: 4 \| 2026: 5, 2035: 4 \|  \|/);
  // inflation, withholding, authToken and enabled differ, out of 10 paths.
  assert.match(report, /4 of 10 settings differ between the two plans\./);
});

test("differencesOnly leaves out matching rows", async () => {
  const report = (
    await runTool({
      planIdentifier: "Main Plan",
      comparePlanIdentifier: "Retire Early",
      differencesOnly: true,
    })
  ).content[0].text;
  assert.match(report, /Only the differing settings are listed\./);
  assert.match(report, /Inflation Rate/);
  assert.doesNotMatch(report, /Stock Growth Rate/);
  assert.match(report, /## Chance of Success \(`montecarlo`\)\n\nNo differing settings\./);
});

test("comparing a plan with itself is refused", async () => {
  const result = await runTool({
    planIdentifier: "Main Plan",
    comparePlanIdentifier: "plan_main",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /name the same plan/);
});

test("an unknown plan is refused with the available names", async () => {
  const result = await runTool({ planIdentifier: "Nope" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Main Plan/);
});

test("the renderer works on a ProjectionLab 4 plan", () => {
  const report = renderSettingsReport(
    [{ id: "p1", name: "Legacy", variables: { inflation: 3 }, montecarlo: {}, withdrawalStrategy: {} }],
    "v4",
  );
  assert.match(report, /\| Inflation Rate \| 3% \|/);
  assert.match(report, /## Chance of Success \(`montecarlo`\)\n\nNo stored settings\./);
  assert.doesNotMatch(report, /\u2014/);
});
