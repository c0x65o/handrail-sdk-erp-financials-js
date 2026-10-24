import {createHash} from "node:crypto";
import {appendFinancialLifecycleEvent,type FinancialOperationContext} from "./financial-lifecycle.js";
import {ErpFinancialsError} from "./sdk-errors.js";
import type {AccountClassification,JsonValue} from "./canonical-model.js";
import type {PostgresQueryClient} from "./postgres-storage.js";

export type JournalAccountRequirement={readonly accountId:string;readonly classifications:readonly AccountClassification[]};
export type JournalAccountPolicyRequest={readonly sourceId:string;readonly transactionId:string;readonly limit?:number;readonly cursor?:string};
export type JournalAccountPolicyPage={readonly items:readonly {readonly chunkIndex:number;readonly requirements:readonly JournalAccountRequirement[]}[];readonly requirementCount:number;readonly checksum:string;readonly nextCursor?:string};
type Scope={readonly tenantId:string;readonly companyId:string;readonly bookId:string};
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid=(message:string):never=>{throw new ErpFinancialsError("invalid_input",message);};
const corrupt=():never=>{throw new ErpFinancialsError("reconciliation_conflict","Stored journal account policy evidence is incomplete");};
const eventType="journal.account_policy.recorded";
/** Original ordered requirements are retained, including duplicates. The root
 * checksum binds every chunk; all rows share the posting's caller transaction. */
export async function retainJournalAccountPolicy(client:PostgresQueryClient,input:{tenantId:string;companyId:string;sourceId:string;transactionId:string;operation:FinancialOperationContext;recordedAt:string;requirements:readonly JournalAccountRequirement[]}):Promise<Record<string,JsonValue>>{
 const requirements=input.requirements;
 if(!requirements.length)return {};
 if(Buffer.byteLength(JSON.stringify(requirements),"utf8")<=2048)return {executionAccountRequirements:requirements as unknown as JsonValue};
 const chunks:JournalAccountRequirement[][]=[];let current:JournalAccountRequirement[]=[];
 for(const requirement of requirements){
  if(Buffer.byteLength(JSON.stringify([requirement]),"utf8")>2048)invalid("A single journal account policy requirement exceeds the audit field limit");
  if(current.length&&Buffer.byteLength(JSON.stringify([...current,requirement]),"utf8")>2048){chunks.push(current);current=[];}
  current.push(requirement);
 }
 if(current.length)chunks.push(current);
 const checksum=hash(requirements),chunkKeyPrefix=`journal-policy:${input.transactionId}:`;
 for(const [chunkIndex,entries] of chunks.entries())await appendFinancialLifecycleEvent(client,{
  tenantId:input.tenantId,companyId:input.companyId,sourceId:input.sourceId,aggregateType:"journal_account_policy",aggregateId:input.transactionId,
  eventType,idempotencyKey:`${chunkKeyPrefix}${String(chunkIndex)}`,operation:input.operation,recordedAt:input.recordedAt,
  payload:{transactionId:input.transactionId,checksum,chunkIndex,requirements:entries as unknown as JsonValue}
 });
 return {executionAccountPolicy:{version:1,checksum,requirementCount:requirements.length,chunkCount:chunks.length,chunkKeyPrefix}};
}
/** Bounded exact-key chunk reads; never scan a document's posting lines or an
 * entire ledger to recover audit policy. The caller verifies the active book. */
export async function readJournalAccountPolicy(client:PostgresQueryClient,scope:Scope,raw:JournalAccountPolicyRequest):Promise<JournalAccountPolicyPage>{
 const input=structuredClone(raw),limit=input.limit??20;
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||typeof input.sourceId!=="string"||!input.sourceId||typeof input.transactionId!=="string"||!input.transactionId)invalid("Invalid journal account policy page request");
 const binding=hash([scope.tenantId,scope.companyId,scope.bookId,input.sourceId,input.transactionId]);let start=0;
 if(input.cursor!==undefined){if(typeof input.cursor!=="string"||input.cursor.length>2048)invalid("Invalid journal account policy cursor");try{const c=JSON.parse(Buffer.from(input.cursor,"base64url").toString()) as {binding:string;start:number};if(c.binding!==binding||!Number.isSafeInteger(c.start)||c.start<0)invalid("Invalid journal account policy cursor");start=c.start;}catch{invalid("Invalid journal account policy cursor");}}
 const journal=(await client.query(`select t.transaction_id from erp_financials.transactions t
  join erp_financials.reporting_book_sources s on s.tenant_id=t.tenant_id and s.source_id=t.source_id and s.company_id=$2 and s.book_id=$3
  join erp_financials.reporting_books b on b.tenant_id=s.tenant_id and b.company_id=s.company_id and b.book_id=s.book_id
  where t.tenant_id=$1 and t.source_id=$4 and t.transaction_id=$5 and t.status='posted' and t.currency_code=b.base_currency_code and b.status='active'
   and (s.effective_from is null or s.effective_from<=t.transaction_date) and (s.effective_through is null or s.effective_through>=t.transaction_date) for share of s,b,t`,[scope.tenantId,scope.companyId,scope.bookId,input.sourceId,input.transactionId])).rows;
 if(journal.length!==1)throw new ErpFinancialsError("missing_document","Journal is not in the reporting book");
 const rows=(await client.query<{payload:Record<string,unknown>}>(`select payload from erp_financials.financial_lifecycle_events where tenant_id=$1 and company_id=$2 and source_id=$3
  and aggregate_type=any($4::text[]) and aggregate_id=$5 and (payload ? 'executionAccountRequirements' or payload ? 'executionAccountPolicy') limit 2`,[scope.tenantId,scope.companyId,input.sourceId,["journal_entry","subledger_document"],input.transactionId])).rows;
 if(rows.length>1)return corrupt();
 const payload=rows[0]?.payload;if(!payload)return {items:[],requirementCount:0,checksum:hash([])};
 if(Array.isArray(payload.executionAccountRequirements)){
  const requirements=payload.executionAccountRequirements as JournalAccountRequirement[];
  return {items:start===0?[{chunkIndex:0,requirements}]:[],requirementCount:requirements.length,checksum:hash(requirements)};
 }
 const manifest=payload.executionAccountPolicy as {version:number;checksum:string;requirementCount:number;chunkCount:number;chunkKeyPrefix:string}|undefined;
 if(!manifest||manifest.version!==1||!Number.isSafeInteger(manifest.chunkCount)||manifest.chunkCount<1||!Number.isSafeInteger(manifest.requirementCount)||manifest.requirementCount<1||!/^[a-f0-9]{64}$/.test(manifest.checksum)||manifest.chunkKeyPrefix!==`journal-policy:${input.transactionId}:`)return corrupt();
 const end=Math.min(start+limit,manifest.chunkCount),keys=Array.from({length:Math.max(0,end-start)},(_,i)=>`${manifest.chunkKeyPrefix}${String(start+i)}`);
 const chunks=keys.length?(await client.query<{payload:{checksum:string;chunkIndex:number;requirements:JournalAccountRequirement[]}}>(`select payload from erp_financials.financial_lifecycle_events where tenant_id=$1 and company_id=$2 and source_id=$3 and aggregate_type='journal_account_policy' and aggregate_id=$4 and event_type=$5 and idempotency_key=any($6::text[])`,[scope.tenantId,scope.companyId,input.sourceId,input.transactionId,eventType,keys])).rows:[];
 if(chunks.length!==keys.length)return corrupt();
 const items=chunks.map(row=>row.payload).sort((a,b)=>a.chunkIndex-b.chunkIndex);
 if(items.some((item,index)=>item.checksum!==manifest.checksum||item.chunkIndex!==start+index||!Array.isArray(item.requirements)))return corrupt();
 return {items:items.map(({chunkIndex,requirements})=>({chunkIndex,requirements})),requirementCount:manifest.requirementCount,checksum:manifest.checksum,...(end<manifest.chunkCount?{nextCursor:Buffer.from(JSON.stringify({binding,start:end})).toString("base64url")}:{})};
}
