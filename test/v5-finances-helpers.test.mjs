// Current Finances helpers (src/currentFinances.ts, src/realEstate.ts) on
// ProjectionLab 5 accounts.

import assert from "node:assert/strict";
import test from "node:test";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.LOG_LEVEL = "error";

const finances = await import("../dist/currentFinances.js");
const realEstate = await import("../dist/realEstate.js");

const v5Finances = () => structuredClone(v5Export().documents.currentFinances);

test("listV5Accounts lists every record, archived included, with its kind and type", () => {
  const entries = finances.listV5Accounts(v5Finances());

  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.kind, entry.type, entry.archived]),
    [
      ["acct_brokerage", "account", "taxable", false],
      ["acct_401k", "account", "401k", false],
      ["acct_old_savings", "account", "savings", true],
      ["asset_land", "real-asset", "land", false],
      ["debt_land_loan", "debt", "secured-loan", false],
    ],
  );
});

test("listV5Accounts treats archivedOn as the archive marker and ignores a null one", () => {
  const doc = v5Finances();
  doc.accounts.acct_brokerage.archivedOn = null;
  const brokerage = finances
    .listV5Accounts(doc)
    .find((entry) => entry.id === "acct_brokerage");

  assert.equal(brokerage.archived, false);
});

test("listV5Accounts falls back to the key for a record without an id and skips non-records", () => {
  const doc = v5Finances();
  delete doc.accounts.acct_401k.id;
  doc.accounts.junk = "not a record";
  const entries = finances.listV5Accounts(doc);

  assert.equal(entries.some((entry) => entry.id === "acct_401k"), true);
  assert.equal(entries.some((entry) => entry.key === "junk"), false);
});

test("listV5Accounts is empty for anything that is not an accounts object", () => {
  assert.deepEqual(finances.listV5Accounts({ investmentAccounts: [{ id: "a" }] }), []);
  assert.deepEqual(finances.listV5Accounts({ accounts: [{ id: "a" }] }), []);
  assert.deepEqual(finances.listV5Accounts(undefined), []);
  assert.deepEqual(finances.listV5Accounts(null), []);
});

test("findV5Account matches the id, then the key, and does not hide archived accounts", () => {
  const doc = v5Finances();
  assert.equal(finances.findV5Account(doc, "acct_old_savings").archived, true);
  assert.equal(finances.findV5Account(doc, "missing"), undefined);

  doc.accounts.acct_401k.id = "renamed";
  assert.equal(finances.findV5Account(doc, "renamed").key, "acct_401k");
  assert.equal(finances.findV5Account(doc, "acct_401k").id, "renamed");
});

test("v5 net worth: accounts add balance, real assets add value, debts subtract balance", () => {
  const byId = Object.fromEntries(
    finances.listV5Accounts(v5Finances()).map((entry) => [entry.id, entry]),
  );

  assert.equal(finances.v5NetWorthContribution(byId.acct_brokerage), 50000);
  assert.equal(finances.v5NetWorthContribution(byId.asset_land), 120000);
  assert.equal(finances.v5NetWorthContribution(byId.debt_land_loan), -60000);
  assert.equal(finances.v5AccountAmount(byId.debt_land_loan), 60000);
});

test("v5 net worth gives an unrecognized kind no amount, and a missing or bad number counts as 0", () => {
  const doc = v5Finances();
  doc.accounts.odd = { id: "odd", name: "Odd", kind: "other-kind", balance: 5 };
  doc.accounts.blank = { id: "blank", name: "Blank", kind: "account" };
  doc.accounts.bad = { id: "bad", name: "Bad", kind: "account", balance: "oops" };
  const byId = Object.fromEntries(
    finances.listV5Accounts(doc).map((entry) => [entry.id, entry]),
  );

  assert.equal(finances.v5NetWorthContribution(byId.odd), undefined);
  assert.equal(finances.v5NetWorthContribution(byId.blank), 0);
  assert.equal(finances.v5NetWorthContribution(byId.bad), 0);
});

test("withoutArchivedAccounts drops archived records, lists them apart, and leaves the input intact", () => {
  const doc = v5Finances();
  const before = structuredClone(doc);
  const view = finances.withoutArchivedAccounts(doc);

  assert.equal("acct_old_savings" in view.accounts, false);
  assert.equal("asset_land" in view.accounts, true);
  assert.deepEqual(view.archivedAccounts.map((stub) => stub.id), ["acct_old_savings"]);
  assert.deepEqual(doc, before);
});

test("currentFinancesProblems compares v5 accounts by id", () => {
  const before = v5Finances();
  assert.deepEqual(finances.currentFinancesProblems(before, structuredClone(before)), []);

  const changed = structuredClone(before);
  changed.accounts.acct_brokerage.balance = 1;
  delete changed.accounts.debt_land_loan;
  changed.accounts.acct_new = { id: "acct_new", kind: "account", balance: 5 };
  const problems = finances.currentFinancesProblems(before, changed);

  assert.deepEqual(problems.sort(), [
    "Current Finances accounts acct_new was added",
    "Current Finances accounts acct_brokerage balance changed from 50000 to 1",
    "Current Finances accounts debt_land_loan is missing",
  ].sort());
});

test("currentFinanceAccountNotFoundError counts v5 accounts", () => {
  const error = finances.currentFinanceAccountNotFoundError(v5Finances(), "nope");

  assert.equal(error.code, "INVALID_INPUT");
  assert.match(error.suggestion, /5 available account record/);
});

test("requireCurrentFinances accepts a v5 document and refuses a missing one", () => {
  const doc = v5Finances();
  assert.equal(finances.requireCurrentFinances(doc), doc);
  assert.throws(() => finances.requireCurrentFinances(undefined), /No current finances data/);
});

function entriesOf(doc) {
  return finances.listV5Accounts(doc);
}

test("buildRealAssetBlock states equity as value minus the unarchived debts that name the asset", () => {
  const doc = v5Finances();
  doc.accounts.debt_second = {
    id: "debt_second",
    name: "Second Lien",
    kind: "debt",
    type: "secured-loan",
    balance: 10000,
    securedByAssetId: "asset_land",
  };
  doc.accounts.debt_archived = {
    id: "debt_archived",
    name: "Paid Off",
    kind: "debt",
    type: "secured-loan",
    balance: 99999,
    securedByAssetId: "asset_land",
    archivedOn: "2024-02-02",
  };
  doc.accounts.debt_other = {
    id: "debt_other",
    name: "Other Asset Loan",
    kind: "debt",
    type: "secured-loan",
    balance: 7000,
    securedByAssetId: "asset_elsewhere",
  };
  doc.accounts.debt_free = { id: "debt_free", name: "Card", kind: "debt", type: "credit-card", balance: 300 };
  const entries = entriesOf(doc);
  const land = entries.find((entry) => entry.id === "asset_land");
  const block = realEstate.buildRealAssetBlock(land, entries);

  assert.equal(block.value, 120000);
  assert.equal(block.purchasePrice, 100000);
  assert.equal(block.loanBalance, 70000);
  assert.equal(block.equity, 50000);
  assert.deepEqual(block.securedDebts.map((debt) => debt.id), ["debt_land_loan", "debt_second"]);
});

test("buildRealAssetBlock is null for any kind but real-asset and omits an absent purchase price", () => {
  const doc = v5Finances();
  const entries = entriesOf(doc);
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));

  assert.equal(realEstate.buildRealAssetBlock(byId.acct_brokerage, entries), null);
  assert.equal(realEstate.buildRealAssetBlock(byId.debt_land_loan, entries), null);

  delete doc.accounts.asset_land.purchasePrice;
  const noPrice = entriesOf(doc);
  const land = noPrice.find((entry) => entry.id === "asset_land");
  assert.equal("purchasePrice" in realEstate.buildRealAssetBlock(land, noPrice), false);
});

test("withRealAssetBlocks replaces real-asset records without mutating the input", () => {
  const doc = v5Finances();
  const before = structuredClone(doc);
  const out = realEstate.withRealAssetBlocks(doc);

  assert.equal(out.accounts.asset_land.realAsset.equity, 60000);
  assert.equal(out.accounts.acct_brokerage, doc.accounts.acct_brokerage);
  assert.deepEqual(doc, before);
});

test("withRealAssetBlocks returns the same object when no real asset qualifies", () => {
  const doc = v5Finances();
  delete doc.accounts.asset_land;
  assert.equal(realEstate.withRealAssetBlocks(doc), doc);
  const empty = {};
  assert.equal(realEstate.withRealAssetBlocks(empty), empty);
});
