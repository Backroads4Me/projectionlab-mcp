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

const { formatValue, parseEnabledBy, renderSettingsReport } = await import(
  "../dist/settingsReport.js"
);
const { REPORT_TOPICS } = await import("../dist/settingsReportLayout.js");
const { matchDataModelField } = await import("../dist/dataModel.js");
const { listPlanSettings } = await import("../dist/planSettings.js");
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
  const shared = (plan) => ({
    investmentReturn: 7,
    assumptionsMode: "fixed",
    startYear: 1928,
    investmentReturnCustom: { type: "%", data: [{ x: 1, y: 5 }, { x: 20, y: 4 }] },
    notes: "a | b",
    filingStatus: "joint",
    bondSettings: {
      location: { type: "account-order", accountOrder: [`${plan.id}_ev_brokerage`] },
    },
  });
  main.variables = {
    ...shared(main),
    inflation: 3,
    withholding: { taxDeferred: 10 },
    integration: { authToken: "sensitive" },
    rothConversionStrategy: {
      enabled: true,
      start: { type: "keyword", value: "beforeCurrentYear" },
      end: { type: "milestone", value: `${main.id}_ms_retire`, modifier: 2 },
    },
  };
  early.variables = { ...shared(early), inflation: 2.5, assumptionsMode: "historical" };
  main.montecarlo = { inflation: "custom", inflationMean: 3, inflationStdDev: 1.5 };
  early.montecarlo = { inflation: "custom", inflationMean: 3, inflationStdDev: 1.5 };
  const strategy = (enabled) => ({
    enabled,
    strategy: "initial-%",
    "initial-%": { amount: 4, min: 10000, minEnabled: true, minType: "today$", max: 0, maxEnabled: false, maxType: "%" },
    "fixed-%": { amount: 5 },
  });
  main.withdrawalStrategy = strategy(false);
  early.withdrawalStrategy = strategy(true);
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

async function report(args) {
  const result = await runTool(args);
  assert.equal(result.isError, undefined);
  return result.content[0].text;
}

/** The text of a heading's block, up to the next heading of the same or higher level. */
function block(text, heading) {
  const start = text.indexOf(`${heading}\n`);
  assert.ok(start >= 0, `missing ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
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

test("enabledBy is read in its three forms and nothing else", () => {
  assert.deepEqual(parseEnabledBy("taxStrategy.irmaaCeiling"), [{ path: "taxStrategy.irmaaCeiling" }]);
  assert.deepEqual(parseEnabledBy('assumptionsMode "historical"'), [
    { path: "assumptionsMode", equals: "historical" },
  ]);
  assert.deepEqual(parseEnabledBy("estate.stepUpBasis false"), [
    { path: "estate.stepUpBasis", equals: false },
  ]);
  assert.deepEqual(parseEnabledBy("when the plan has a spouse"), []);
  assert.deepEqual(parseEnabledBy(undefined), []);
});

test("main settings come first, grouped by topic, then more and advanced ones", async () => {
  const text = await report({ planIdentifier: "Main Plan" });
  assert.match(text, /^# Plan settings: Main Plan\n/);
  const order = [
    "## Main settings",
    "### Growth and inflation",
    "### Tax strategy and Roth conversions",
    "### Taxes",
    "## More settings",
    "### Chance of Success",
    "## Not in effect with the current choices",
    "## Other stored settings",
  ].map((heading) => text.indexOf(`${heading}\n`));
  assert.ok(order.every((at) => at >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  const growth = block(text, "### Growth and inflation");
  assert.match(growth, /\| \*Rates mode\* \| Fixed \|/);
  assert.match(growth, /\| Inflation Rate \| 3% \|/);
  assert.match(growth, /\| Stock Growth Rate \| 7% \|/);
  assert.ok(growth.indexOf("Inflation Rate") < growth.indexOf("Stock Growth Rate"));
  assert.match(block(text, "### Taxes"), /\| Tax-Deferred Withdrawals \| 10% \|/);
  assert.match(block(text, "### Taxes"), /\| \*Filing status\* \| Married filing jointly \|/);
  assert.match(
    block(text, "### Chance of Success"),
    /\| Inflation: Mean \| 3% \|\n\| Inflation: Std\. Dev\. \| 1\.5% \|/,
  );
});

test("combined rows read references, account names, and withdrawal bounds", async () => {
  const text = await report({ planIdentifier: "Retire Early" });
  assert.match(text, /\| \*Bond account order\* \| Brokerage \|/);
  const strategy = block(text, "### Withdrawal strategy: Initial Percentage");
  assert.match(strategy, /\| \*Minimum withdrawal\* \| \$10,000 in today's dollars \|/);
  assert.match(strategy, /\| \*Maximum withdrawal\* \| Off \|/);
  assert.doesNotMatch(text, /minEnabled|maxType/);

  const main = await report({ planIdentifier: "Main Plan" });
  const roth = block(main, "### Tax strategy and Roth conversions");
  assert.match(roth, /\| \*Roth conversions start\* \| Before current year \|/);
  assert.match(roth, /\| \*Roth conversions end\* \| Retirement \+2 \|/);
});

test("settings the current choices leave unused move to Not in effect", async () => {
  const text = await report({ planIdentifier: "Main Plan" });
  const unused = block(text, "## Not in effect with the current choices");
  // The data model's enabledBy: startYear needs historical rates.
  assert.match(unused, /\| Start Year \| 1928 \| \*Rates mode\* is Historical \|/);
  // The topic's own condition: custom curves need custom rates.
  assert.match(unused, /\| \*Stock growth curve\* \| 1: 5%, 20: 4% \| \*Rates mode\* is Custom \|/);
  // The textbook switch is off, so the whole strategy waits on it.
  assert.match(unused, /\| \*Strategy\* \| Initial Percentage \| Textbook Strategy is On \|/);
  // A topic's own condition is said once, under its heading.
  assert.match(
    unused,
    /### Withdrawal strategy: Fixed Percentage\n\nUsed when Textbook Strategy is On and \*Strategy\* is Fixed Percentage\.\n\n\| Setting \| Value \|\n/,
  );
  // The selected rule is listed before the others.
  assert.ok(
    unused.indexOf("### Withdrawal strategy: Initial Percentage") <
      unused.indexOf("### Withdrawal strategy: Fixed Percentage"),
  );
  // A fixed rate stays in place, and the switch itself stays at the top.
  const main = block(text, "## Main settings");
  assert.match(main, /\| Textbook Strategy \| Off \|/);
  assert.doesNotMatch(unused, /Inflation Rate/);
});

test("in a two-plan report a setting in effect in either plan stays in place", async () => {
  const text = await report({ planIdentifier: "Main Plan", comparePlanIdentifier: "Retire Early" });
  assert.match(text, /^# Plan settings: Main Plan vs Retire Early\n/);
  const main = block(text, "## Main settings");
  // Retire Early uses historical rates and the textbook strategy.
  assert.match(main, /\| Start Year \| 1928 \| 1928 \|  \|/);
  assert.match(main, /### Withdrawal strategy: Initial Percentage/);
  // Fixed Percentage is the active rule in neither plan.
  assert.match(block(text, "## Not in effect with the current choices"), /### Withdrawal strategy: Fixed Percentage/);
  assert.doesNotMatch(main, /Fixed Percentage/);
});

test("a two-plan report marks differences and settings only one plan holds", async () => {
  const text = await report({ planIdentifier: "Main Plan", comparePlanIdentifier: "Retire Early" });
  assert.match(text, /\| Setting \| Main Plan \| Retire Early \| Differs \|/);
  assert.match(text, /\| Inflation Rate \| 3% \| 2\.5% \| \*\*Yes\*\* \|/);
  assert.match(text, /\| Stock Growth Rate \| 7% \| 7% \|  \|/);
  assert.match(text, /\| Tax-Deferred Withdrawals \| 10% \| not set \| \*\*Yes\*\* \|/);
  assert.match(text, /\| Textbook Strategy \| Off \| On \| \*\*Yes\*\* \|/);
  // Equal curves compare by value, and account ids by the name they show.
  assert.match(text, /\| \*Stock growth curve\* \| 1: 5%, 20: 4% \| 1: 5%, 20: 4% \|  \|/);
  assert.match(text, /\| \*Bond account order\* \| Brokerage \| Brokerage \|  \|/);
  assert.match(text, /(\d+) of (\d+) settings differ between the two plans\./);
});

test("differencesOnly leaves out matching rows", async () => {
  const text = await report({
    planIdentifier: "Main Plan",
    comparePlanIdentifier: "Retire Early",
    differencesOnly: true,
  });
  assert.match(text, /Only the differing settings are listed\./);
  assert.match(text, /Inflation Rate/);
  assert.doesNotMatch(text, /Stock Growth Rate/);
  assert.doesNotMatch(text, /### Chance of Success/);
});

test("a section filter keeps only that section's topics", async () => {
  const text = await report({ planIdentifier: "Main Plan", section: "montecarlo" });
  assert.match(text, /### Chance of Success/);
  assert.doesNotMatch(text, /Growth and inflation|Textbook Strategy/);
});

test("unnamed paths close the report, pipes are escaped, secrets stay redacted", async () => {
  const text = await report({ planIdentifier: "Main Plan" });
  const other = block(text, "## Other stored settings");
  assert.match(other, /\| `notes` \| a \\\| b \|/);
  assert.match(other, /\| `integration\.authToken` \| \[REDACTED\] \|/);
  assert.doesNotMatch(text, /sensitive/);
});

test("every stored path is shown exactly once", async () => {
  const data = exportWithSettings();
  const plan = data.documents.plans[0];
  const text = await report({ planIdentifier: "Main Plan" });
  const rows = text
    .split("\n")
    .filter((line) => line.startsWith("| ") && !/^\| (Setting|---) \|/.test(line));
  const expected = ["variables", "montecarlo", "withdrawalStrategy"].flatMap(
    (section) => listPlanSettings(plan[section]).map((setting) => setting.path),
  );
  // Combined rows fold several stored paths into one; the rest are one row each.
  assert.ok(rows.length <= expected.length);
  const total = Number(text.match(/^(\d+) settings\.$/m)[1]);
  assert.equal(rows.length, total);
  for (const path of ["notes", "integration.authToken"]) {
    assert.equal(rows.filter((row) => row.includes(`\`${path}\``)).length, 1, path);
  }
  assert.doesNotMatch(text, /`initial-%|`rothConversionStrategy|`bondSettings/);
});

test("every main-tier row has an on-screen label or a data-model description", () => {
  for (const topic of REPORT_TOPICS.filter((entry) => entry.tier === "main")) {
    for (const row of topic.rows) {
      const field = matchDataModelField(topic.section, row.path, "v5");
      // A combined row (a curve, a bound, a start or end) is named by the layout.
      const combined = row.kind !== undefined && row.kind !== "value" && row.name;
      assert.ok(
        field?.uiLabel || field?.description || combined,
        `${topic.section}.${row.path}`,
      );
    }
  }
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
  const text = renderSettingsReport(
    [{ id: "p1", name: "Legacy", variables: { inflation: 3 }, montecarlo: {}, withdrawalStrategy: {} }],
    "v4",
  );
  assert.match(text, /\| Inflation Rate \| 3% \|/);
  assert.doesNotMatch(text, /### Chance of Success/);
  assert.doesNotMatch(text, /—/);
});
