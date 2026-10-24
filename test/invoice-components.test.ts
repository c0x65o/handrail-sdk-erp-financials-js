import { describe, expect, it } from "vitest";
import { normalizeCommercialDocumentLine } from "../src/commercial-lines.js";
import { invoiceComponentJournalLines, normalizeInvoiceComponents } from "../src/invoice-components.js";

const line={accountId:"income",...normalizeCommercialDocumentLine({amount:"178.08",quantity:"12",unitAmount:"15.00",discountAmount:"12.00",taxAmount:"10.08",description:"Merchandise",dimensionRefs:[{dimensionKind:"order",sourceDimensionId:"order-1"}]})};
describe("explicit invoice posting components",()=>{
  it("posts gross revenue, contra discount and tax liability while retaining the net receivable",()=>{
    const lines=invoiceComponentJournalLines({...line,taxAccount:{accountId:"tax"},discountAccount:{accountId:"discount"}},"customer");
    expect(lines.map(row=>[row.accountId,row.debit??"0.00",row.credit??"0.00"])).toEqual([["income","0.00","180.00"],["tax","0.00","10.08"],["discount","12.00","0.00"]]);
    expect(lines.every(row=>row.partyId==="customer"&&row.dimensionRefs===line.dimensionRefs)).toBe(true);
    const reversed=invoiceComponentJournalLines({...line,taxAccount:{accountId:"tax"},discountAccount:{accountId:"discount"}},"customer",true);
    expect(reversed.map(row=>[row.accountId,row.credit??"0.00",row.debit??"0.00"])).toEqual(lines.map(row=>[row.accountId,row.debit??"0.00",row.credit??"0.00"]));
  });
  it("retains existing consumer behavior without explicit component accounts",()=>{
    expect(invoiceComponentJournalLines(line,"customer").map(row=>[row.accountId,row.credit])).toEqual([["income","178.08"]]);
    expect(invoiceComponentJournalLines({...line,taxAccount:{accountKey:"tax"}},"customer").map(row=>[row.accountId??row.accountKey,row.credit])).toEqual([["income","168.00"],["tax","10.08"]]);
  });
  it("rejects ambiguous or empty component references",()=>{
    for(const reference of [null,[],{}, {accountId:"a",accountKey:"b"},{accountId:""},{accountKey:" "},{accountId:1},{accountId:"a",unknown:true}]) {
      expect(()=>normalizeInvoiceComponents({taxAccount:reference} as never)).toThrow(/components/);
    }
    expect(normalizeInvoiceComponents({taxAccount:{accountKey:"tax"},discountAccount:{accountId:"discount"}})).toEqual({taxAccount:{accountKey:"tax"},discountAccount:{accountId:"discount"}});
  });
  it("keeps money exact above JavaScript safe-integer cents",()=>{
    const large={accountId:"income",...normalizeCommercialDocumentLine({quantity:"1",unitAmount:"9999999999999999.99",discountAmount:"0.01",taxAmount:"0.02",amount:"10000000000000000.00"}),taxAccount:{accountId:"tax"},discountAccount:{accountId:"discount"}};
    expect(invoiceComponentJournalLines(large,"customer").map(row=>row.credit??row.debit)).toEqual(["9999999999999999.99","0.02","0.01"]);
  });
});
