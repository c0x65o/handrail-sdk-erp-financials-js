import { describe, expect, it } from 'vitest';
import { planAttestedSettlement, type AttestedSettlementState, type AttestedSettlementRequest } from '../src/attested-settlement-correction.js';
export function fixture() {
  const state: AttestedSettlementState = {
    stale:{id:'stale',partyId:'customer',currency:'USD',version:2,original:'27.56',open:'0',status:'settled'},
    replacement:{id:'replacement',partyId:'customer',currency:'USD',version:11,original:'330.72',open:'57.2500',status:'partially_applied'},
    invoice:{id:'invoice',partyId:'customer',currency:'USD',version:3,original:'27.56',open:'0.00',status:'settled'},
    application:{id:'application',version:1,sourceId:'stale',targetId:'invoice',amount:'27.56',active:true},staleActiveApplicationCount:1,amount:'27.56'
  };
  const request: AttestedSettlementRequest = {paymentId:'stale',replacementPaymentId:'replacement',invoiceId:'invoice',applicationId:'application',offsetTransactionId:'journal',amount:'27.56',date:'2026-11-06',idempotencyKey:'request',expectedVersions:{payment:2,replacement:11,invoice:3,application:1},
    attestation:{approvedBy:'owner',authorizationRefs:['p-t95u','p-t94u'],evidenceSha256:'a'.repeat(64),erroneousReceiptNeverProcessed:true,acceptUnchangedCashHistory:true,providerDeletionVerified:false},
    operation:{actorRef:'admin',requestId:'request',correlationId:'request',reasonCode:'attested_settlement',occurredAt:'2026-11-06T14:00:00Z'}};
  return {state,request};
}
describe('settlement-only attestation',()=>{
  it('plans29.69 without any journal instructions and honestly retains cash/provider limitations',()=>{
    const {state,request}=fixture();expect(planAttestedSettlement(state,request)).toMatchObject({replacementOpenAfter:'29.69',invoiceOpenAfter:'0.00',ledgerPolicy:'preserve_all_postings',providerConvergence:'unverified'});
  });
  it.each(['payment','replacement','invoice','application'] as const)('rejects stale %s version',key=>{const {state,request}=fixture();request.expectedVersions[key]++;expect(()=>planAttestedSettlement(state,request)).toThrow('Reload');});
  it.each(['erroneousReceiptNeverProcessed','acceptUnchangedCashHistory'] as const)('requires %s attestation',key=>{const {state,request}=fixture();request.attestation[key]=false;expect(()=>planAttestedSettlement(state,request)).toThrow('attestation');});
  it('never converts owner attestation into provider verification',()=>{const {state,request}=fixture();request.attestation.providerDeletionVerified=true;expect(()=>planAttestedSettlement(state,request)).toThrow('provider verification');});
  it.each(['partyId','currency'] as const)('rejects cross %s',key=>{const {state,request}=fixture();state.replacement[key]='other';expect(()=>planAttestedSettlement(state,request)).toThrow('Same customer');});
  it('rejects insufficient credit',()=>{const {state,request}=fixture();state.replacement.open='27.55';expect(()=>planAttestedSettlement(state,request)).toThrow('insufficient');});
  it('rejects another active application',()=>{const {state,request}=fixture();state.staleActiveApplicationCount=2;expect(()=>planAttestedSettlement(state,request)).toThrow('one full');});
  it('rejects mismatched invoice and inactive application',()=>{const {state,request}=fixture();state.application.active=false;expect(()=>planAttestedSettlement(state,request)).toThrow('one full');});
  it('rejects fractional cents',()=>{const {state,request}=fixture();request.amount='27.561';expect(()=>planAttestedSettlement(state,request)).toThrow('cent');});
  it('requires owner attribution and evidence',()=>{const {state,request}=fixture();request.attestation.approvedBy='';expect(()=>planAttestedSettlement(state,request)).toThrow('attestation');});
  it('requires real effective date',()=>{const {state,request}=fixture();request.date='2026-02-30';expect(()=>planAttestedSettlement(state,request)).toThrow('date');});
});
