import { expect, it } from "vitest";
import { buildNormalizedQuickBooksProviderReportResponse, createHandrailQuickBooksFullSyncServiceHandler, ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES as fixtures } from "../src/index.js";
const request = fixtures.providerReports.cashFlow.request;
const provider = () => ({ ...fixtures.providerReports.profitAndLoss.providerResult,
  providerReportRef: { ...fixtures.providerReports.profitAndLoss.providerResult.providerReportRef, reportName: "cash_flow" as const },
  totals: Object.entries({ net_income: "100.00", net_operating_cash: "120.00", net_investing_cash: "-30.00", net_financing_cash: "10.00", net_cash_flow: "100.00", cash_beginning: "500.00", cash_ending: "600.00" }).map(([totalKey, amount]) => ({ totalKey, amount })),
});
it("accepts immutable complete cash-flow evidence and opts the loader in independently", async () => {
  const input = provider(); const before = structuredClone(input);
  const service = createHandrailQuickBooksFullSyncServiceHandler({ loadFullSyncResources: () => { throw new Error("not called"); }, loadCashFlowProviderReport: () => input });
  expect(await service.cashFlowParityReport(request)).toMatchObject({ supportStatus: "supported", reportName: "cash_flow", totals: input.totals, providerReportRef: input.providerReportRef });
  expect(input).toEqual(before);
});
it.each(["missing", "duplicate", "unknown", "malformed", "net", "ending", "currency", "identity"])("rejects %s cash-flow evidence", kind => {
  const input = provider();
  const first = input.totals[0]; const operating = input.totals[1]; const ending = input.totals[6];
  if (!first || !operating || !ending) throw new Error("Incomplete fixture");
  if (kind === "missing") input.totals.pop();
  if (kind === "duplicate") input.totals.push(first);
  if (kind === "unknown") input.totals.push({ totalKey: "mystery", amount: "0.00" });
  if (kind === "malformed") first.amount = "NaN";
  if (kind === "net") operating.amount = "121.00";
  if (kind === "ending") ending.amount = "601.00";
  if (kind === "identity") input.providerReportRef.realmId = "foreign";
  const candidate = kind === "currency" ? { ...input, totals: input.totals.map(total => ({ ...total, currencyCode: "EUR" })) } : input;
  expect(() => buildNormalizedQuickBooksProviderReportResponse({ ...request, currencyCode: "USD" }, candidate)).toThrow();
});
