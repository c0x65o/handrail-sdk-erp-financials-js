import { describe, expect, it } from "vitest";
import { planJournalSettlement, type JournalSettlementScope } from "../src/quickbooks-journal-settlement.js";
const group = (amounts: bigint[]): JournalSettlementScope => ({ journalId: "fixture-journal", partyId: "fixture-vendor", accountId: "fixture-ap",
  openMinor: amounts.reduce((a,b)=>a+b,0n), lines: amounts.map((openMinor,index)=>({lineId:String(index),openMinor})),lineBalancesKnown:true });
const apply = (scope: JournalSettlementScope, amountMinor: bigint) => planJournalSettlement([scope],{journalId:scope.journalId,partyId:scope.partyId,accountId:scope.accountId,amountMinor});
describe("journal party/account settlement",()=>{
  it("identifies a unique full line",()=>{
    const result=apply(group([3000n,7000n]),3000n);
    expect(result.allocation).toBe("single_line");expect(result.lineIds).toEqual(["0"]);
    expect(result.next.openMinor).toBe(7000n);expect(result.next.lines[0]?.openMinor).toBe(0n);
  });
  it("links all lines for a full multi-line settlement including offsets",()=>{
    const result=apply(group([6000n,5000n,-1000n]),10000n);
    expect(result.allocation).toBe("all_lines");expect(result.lineIds).toEqual(["0","1","2"]);
    expect(result.next.lines.every(line=>line.openMinor===0n)).toBe(true);
  });
  it("preserves an ambiguous partial without inventing line balances",()=>{
    const before=group([6000n,4000n]);const result=apply(before,2500n);
    expect(result).toMatchObject({allocation:"unallocated",lineIds:[],reason:"provider gave no line id; partial amount"});
    expect(result.next.openMinor).toBe(7500n);expect(result.next.lineBalancesKnown).toBe(false);
    expect(result.next.lines).toEqual(before.lines);
    expect(apply(result.next,4000n).allocation).toBe("unallocated");
    expect(apply(result.next,7500n).allocation).toBe("all_lines");
  });
  it("rejects cross-party, ambiguous accounts and overapplication",()=>{
    const scope=group([10000n]);
    expect(()=>planJournalSettlement([scope],{journalId:scope.journalId,partyId:"other",amountMinor:100n})).toThrow();
    expect(()=>planJournalSettlement([scope,{...scope,accountId:"other"}],{journalId:scope.journalId,partyId:scope.partyId,amountMinor:100n})).toThrow();
    expect(()=>apply(scope,10001n)).toThrow();expect(()=>apply(scope,0n)).toThrow();
  });
  it("honors an explicit provider line on a partial",()=>{
    const scope=group([6000n,4000n]);const result=planJournalSettlement([scope],{journalId:scope.journalId,partyId:scope.partyId,amountMinor:2500n,providerLineId:"0"});
    expect(result.allocation).toBe("provider_line");expect(result.next.lines[0]?.openMinor).toBe(3500n);
  });
});
