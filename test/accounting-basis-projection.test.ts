import { describe, expect, it } from "vitest";

import { projectCashBasisApplication } from "../src/accounting-basis-projection.js";
import type { LedgerPosting } from "../src/canonical-model.js";

const common = {
  tenantId: "tenant-1", sourceId: "native", transactionId: "invoice-1",
  postingDate: "2026-01-01", accountingBasis: "accrual" as const,
  currencyCode: "USD", dimensionHash: "dimension", dimensionRefs: [{ dimensionKind: "department", sourceDimensionId: "security" }],
  importBatchId: "original-batch"
};

const postings: readonly LedgerPosting[] = [
  { ...common, postingId: "ar", sourcePostingId: "ar", accountId: "ar", debitAmount: "100.00", creditAmount: "0.00", netAmount: "100.00" },
  { ...common, postingId: "revenue-1", sourcePostingId: "revenue-1", accountId: "revenue", debitAmount: "0.00", creditAmount: "60.00", netAmount: "-60.00" },
  { ...common, postingId: "revenue-2", sourcePostingId: "revenue-2", accountId: "revenue", debitAmount: "0.00", creditAmount: "40.00", netAmount: "-40.00" }
];

describe("cash-basis application projection", () => {
  it("recognizes partial applications proportionally and preserves dimensions", () => {
    const result = projectCashBasisApplication({
      applicationId: "application-1", applicationType: "customer_payment_to_invoice", action: "recognize",
      appliedAmount: "33.33", effectiveDate: "2026-02-01", importBatchId: "projection-batch", accrualPostings: postings
    });
    expect(result.map(({ debitAmount, creditAmount }) => [debitAmount, creditAmount])).toEqual([
      ["33.33", "0.00"], ["0.00", "20.00"], ["0.00", "13.33"]
    ]);
    expect(result[1]).toMatchObject({ accountingBasis: "cash", postingDate: "2026-02-01", dimensionHash: "dimension", dimensionRefs: common.dimensionRefs });
  });

  it("creates equal and opposite deterministic reversal postings", () => {
    const recognize = projectCashBasisApplication({ applicationId: "application-1", applicationType: "customer_payment_to_invoice", action: "recognize", appliedAmount: "33.33", effectiveDate: "2026-02-01", importBatchId: "batch", accrualPostings: postings });
    const reverse = projectCashBasisApplication({ applicationId: "application-1", applicationType: "customer_payment_to_invoice", action: "reverse", appliedAmount: "33.33", effectiveDate: "2026-03-01", importBatchId: "batch", accrualPostings: postings });
    expect(reverse.map(({ debitAmount, creditAmount }) => [debitAmount, creditAmount])).toEqual(recognize.map(({ debitAmount, creditAmount }) => [creditAmount, debitAmount]));
    expect(reverse[0]?.postingId).toBeDefined();
    expect(reverse[0]?.postingId).not.toBe(recognize[0]?.postingId);
  });

  it("rejects unsafe source journals and over-applications", () => {
    expect(() => projectCashBasisApplication({ applicationId: "x", applicationType: "bill_payment_to_bill", action: "recognize", appliedAmount: "100.01", effectiveDate: "2026-01-01", importBatchId: "batch", accrualPostings: postings })).toThrow(/no greater/);
    const firstPosting = postings[0];
    if (firstPosting === undefined) throw new Error("projection fixture requires a posting");
    expect(() => projectCashBasisApplication({ applicationId: "x", applicationType: "bill_payment_to_bill", action: "recognize", appliedAmount: "1.00", effectiveDate: "2026-01-01", importBatchId: "batch", accrualPostings: [{ ...firstPosting, accountingBasis: "cash" }] })).toThrow(/accrual postings only/);
  });
  it("uses net control balances for contra journals and consumes exact remaining cents", () => {
    const [control,firstRevenue,secondRevenue]=postings;
    if(!control||!firstRevenue||!secondRevenue)throw Error("Missing fixture postings");
    const source: LedgerPosting[] = [
      {...control,debitAmount:"0.02",netAmount:"0.02"},
      {...firstRevenue,creditAmount:"0.02",netAmount:"-0.02"},
      {...secondRevenue,creditAmount:"0.01",netAmount:"-0.01"},
      {...control,postingId:"discount",sourcePostingId:"discount",accountId:"discount",debitAmount:"0.01",netAmount:"0.01"}
    ];
    const input = {applicationId:"first",applicationType:"customer_payment_to_invoice" as const,action:"recognize" as const,
      appliedAmount:"0.01",effectiveDate:"2026-02-01",importBatchId:"batch",controlAccountId:"ar",accrualPostings:source};
    const first = projectCashBasisApplication(input);
    expect(first.map(p=>[p.accountId,p.debitAmount,p.creditAmount])).toEqual([
      ["ar","0.01","0.00"],["revenue","0.00","0.01"],["revenue","0.00","0.01"],["discount","0.01","0.00"]
    ]);
    const remaining = source.map(p=>{
      const used=first.find(row=>row.sourcePostingId===`cash-application:first:recognize:${p.sourcePostingId}`);
      const debitAmount=money(cents(p.debitAmount)-cents(used?.debitAmount??"0.00"));
      const creditAmount=money(cents(p.creditAmount)-cents(used?.creditAmount??"0.00"));
      return {...p,debitAmount,creditAmount,netAmount:money(cents(debitAmount)-cents(creditAmount))};
    });
    const second=projectCashBasisApplication({...input,applicationId:"second",accrualPostings:remaining});
    expect(second.map(p=>[p.accountId,p.debitAmount,p.creditAmount])).toEqual([["ar","0.01","0.00"],["revenue","0.00","0.01"]]);
    const originalAllocation=source.map(p=>{
      const allocated=first.find(row=>row.sourcePostingId===`cash-application:first:recognize:${p.sourcePostingId}`);
      if(!allocated)throw Error("Missing allocated posting");
      return {...p,debitAmount:allocated.debitAmount,creditAmount:allocated.creditAmount,netAmount:allocated.netAmount};
    });
    const reversed=projectCashBasisApplication({...input,action:"reverse",accrualPostings:originalAllocation});
    expect(reversed.map(p=>[p.debitAmount,p.creditAmount])).toEqual(first.map(p=>[p.creditAmount,p.debitAmount]));
    const payable=source.map(p=>({...p,debitAmount:p.creditAmount,creditAmount:p.debitAmount,netAmount:money(-cents(p.netAmount))}));
    expect(projectCashBasisApplication({...input,applicationType:"bill_payment_to_bill",accrualPostings:payable}).map(p=>[p.debitAmount,p.creditAmount])).toEqual(first.map(p=>[p.creditAmount,p.debitAmount]));
    expect(()=>projectCashBasisApplication({...input,appliedAmount:"0.03"})).toThrow(/control balance/);
    expect(()=>projectCashBasisApplication({...input,controlAccountId:"missing"})).toThrow(/one explicit control/);
    expect(()=>projectCashBasisApplication({...input,controlAccountId:"revenue"})).toThrow(/one explicit control/);
    expect(()=>projectCashBasisApplication({...input,applicationType:"bill_payment_to_bill"})).toThrow(/control balance/);
  });

});

function cents(value:string):bigint{return BigInt(value.replace(".",""));}
function money(value:bigint):string{const sign=value<0n?"-":"",abs=value<0n?-value:value;return `${sign}${String(abs/100n)}.${String(abs%100n).padStart(2,"0")}`;}
