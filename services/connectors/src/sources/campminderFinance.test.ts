import { describe, expect, it } from "vitest";
import { finDate, isFinancialTab, money, toTransactions, transactionSummary } from "./campminderFinance.js";

const KEY = "k".repeat(40);
// Entirely made-up people and cards; shaped like Campminder's Financial tab.
const tx = (over: Record<string, string> = {}): Record<string, string> => ({
  ID: "56341659",
  "Transaction Number": "T-1001",
  Season: "2026",
  "Post Date": "1/15/2026",
  "Effective Date": "1/15/2026",
  "Reversal Date": "",
  "Is Reversed": "False",
  "Transaction Type": "Debit",
  "Financial Category": "Summer Camp",
  Description: "Tuition for Alex Testperson",
  Quantity: "1",
  "Unit Amount": "$650.00",
  Amount: "$650.00",
  "Payment/Refund Method": "",
  "Check Number": "4417",
  "Deposit Number": "D-99",
  "Credit Card: Issuer": "Visa",
  "Credit Card: Last 4": "4242",
  "Credit Card: Expiration": "12/29",
  "Credit Card: Name On": "Pat Testperson",
  "Credit Card: Processed By CM": "True",
  "Service Start Date": "6/29/2026",
  "Service End Date": "7/3/2026",
  "Session Group Name": "Summer 2026",
  "Session Name": "Farm Week 3",
  "Program Name": "Explorers - Quest",
  "Person ID": "90000001",
  "Last Name": "Testperson",
  "First Name": "Alex",
  "Household ID": "5550001",
  "Household Name": "The Testperson Family",
  "Affected On Transaction Description": "Payment from Pat Testperson",
  "Affected On Transaction Amount": "$650.00",
  ...over,
});

describe("campminder financial tab", () => {
  it("keeps the allow-listed fields", () => {
    const [t] = toTransactions([tx()], KEY);
    expect(t).toMatchObject({
      transactionId: "56341659",
      season: 2026,
      type: "debit",
      category: "Summer Camp",
      postDate: "2026-01-15",
      amount: 650,
      serviceStart: "2026-06-29",
      sessionName: "Farm Week 3",
      sessionGroup: "Farm",
      campminderSessionGroup: "Summer 2026",
      program: "Explorers - Quest",
      isReversed: false,
      isReversal: false,
      affectedAmount: 650,
    });
    expect(t!.personHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t!.familyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never stores names, card or check details, descriptions or raw ids", () => {
    const text = JSON.stringify(toTransactions([tx(), tx({ ID: "56341660", "Transaction Type": "Payment", "Payment/Refund Method": "Credit Card" })], KEY));
    for (const secret of ["Testperson", "Alex", "Pat", "4242", "12/29", "Visa", "4417", "D-99", "T-1001", "Tuition for", "90000001", "5550001"]) {
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
    expect(text).toContain("Credit Card");
  });

  it("reads reversals, money and dates as Campminder writes them", () => {
    const [orig, rev] = toTransactions([tx({ "Is Reversed": "True", "Reversal Date": "2/1/2026" }), tx({ ID: "56341659R", Amount: "($650.00)" })], KEY);
    expect(orig).toMatchObject({ isReversed: true, reversalDate: "2026-02-01" });
    expect(rev).toMatchObject({ isReversal: true, amount: -650 });
    expect(money("-$1,234.50")).toBe(-1234.5);
    expect(money("1234.5")).toBe(1234.5);
    expect(money("")).toBeNull();
    expect(money("n/a")).toBeNull();
    expect(finDate("7/4/2026 3:15 PM")).toBe("2026-07-04");
    expect(isFinancialTab(Object.keys(tx()))).toBe(true);
    expect(isFinancialTab(["PersonID", "Child Session/Status"])).toBe(false);
  });

  it("skips rows without an id, type or season, and sums by type for the log", () => {
    const txs = toTransactions(
      [tx(), tx({ ID: "" }), tx({ ID: "2", Season: "" }), tx({ ID: "3", "Transaction Type": "Payment", Amount: "-$100.00", "Session Name": "" })],
      KEY,
    );
    expect(txs.map((t) => t.transactionId)).toEqual(["56341659", "3"]);
    expect(transactionSummary(txs)).toEqual({
      debit: { rows: 1, positive: 650, negative: 0, withSession: 1, reversed: 0 },
      payment: { rows: 1, positive: 0, negative: -100, withSession: 0, reversed: 0 },
    });
  });
});
