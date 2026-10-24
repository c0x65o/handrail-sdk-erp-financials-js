import {createHash,randomUUID} from 'node:crypto';
import {assertFinancialOperationContext,type FinancialOperationContext} from './financial-lifecycle.js';
import {copyFinancialOperation} from './financial-approval-policy.js';
import {ErpFinancialsError} from './sdk-errors.js';
import type {ErpFinancialsTransactionRunner} from './erp-financials-service.js';
import type {PostgresQueryClient} from './postgres-storage.js';

export type AccountingAccessState = {revision:number;activeSessionId:string|null};
export type AccountingAccessCommand={
 readonly acknowledgeDatabaseWideMaintenance:true;
 readonly commandKey:string;
 readonly expectedRevision:number;
 readonly operation:FinancialOperationContext;
} & ({readonly action:'pause'}|{readonly action:'resume';readonly sessionId:string});
const invalid=(message:string)=>new ErpFinancialsError('invalid_input',message);
const conflict=(message:string)=>new ErpFinancialsError('terminal_state_conflict',message);
const lockKey='erp-financials:accounting-access';

/** Available while paused. This bounded control read is not a financial report
 * or operator authorization; a replay receipt is not the current state. */
export async function readPostgresAccountingAccess(client:PostgresQueryClient):Promise<AccountingAccessState>{
 const row=(await client.query("select revision,active_session_id from erp_financials.accounting_access_control where control_id='database'")).rows[0];
 if(!row)throw conflict('Accounting maintenance control is missing');
 return {revision:Number(row.revision),activeSessionId:row.active_session_id as string|null};
}

/** Control metadata only. Host must authorize the operator for every affected
 * source in this database; this SDK does not infer user grants or cutover proof.
 * Call in one caller-owned transaction. Control commands never post or migrate.
 * Nonwaiting exclusive lock rejects active readers/writers rather than making a
 * stale proof wait. RR stale control state raises serialization failure. */
export async function changePostgresAccountingAccess(client:PostgresQueryClient,raw:AccountingAccessCommand):Promise<AccountingAccessState&{replayed:boolean}>{
 const input=structuredClone(raw),operation=copyFinancialOperation(input.operation);
 assertFinancialOperationContext(operation);
 if((input.acknowledgeDatabaseWideMaintenance as unknown)!==true||!['pause','resume'].includes(input.action)
  ||typeof input.commandKey!=='string'||!input.commandKey.trim()||input.commandKey!==input.commandKey.trim()||input.commandKey.length>200
  ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>=2147483647
  ||input.action==='resume'&&(typeof input.sessionId!=='string'||!input.sessionId||input.sessionId.length>200))throw invalid('Explicit database-wide acknowledgment, bounded command and current revision are required');
 const digest=createHash('sha256').update(JSON.stringify({action:input.action,expectedRevision:input.expectedRevision,
  sessionId:input.action==='resume'?input.sessionId:null,actor:operation.actorRef,approver:operation.approverRef??null,
  reason:operation.reasonCode,reasonDetail:operation.reasonDetail??null,occurredAt:operation.occurredAt})).digest('hex');
 const acquired=(await client.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',[lockKey])).rows[0]?.acquired;
 if(acquired!==true)throw conflict('Accounting access is busy; no maintenance state changed');
 const old=(await client.query('select request_digest,revision,active_session_id from erp_financials.accounting_access_commands where command_key=$1',[input.commandKey])).rows[0];
 if(old){if(old.request_digest!==digest)throw new ErpFinancialsError('idempotency_conflict','Maintenance command belongs to another payload');return {revision:Number(old.revision),activeSessionId:old.active_session_id as string|null,replayed:true};}
 const current=(await client.query('select revision,active_session_id from erp_financials.accounting_access_control where control_id=\'database\' for update')).rows[0];
 if(!current)throw conflict('Accounting maintenance control is missing');
 if(current.revision!==input.expectedRevision)throw new ErpFinancialsError('optimistic_concurrency_conflict','Accounting maintenance revision changed');
 if(input.action==='pause'&&current.active_session_id!==null||input.action==='resume'&&current.active_session_id!==input.sessionId)throw conflict('Accounting maintenance session does not match');
 const activeSessionId=input.action==='pause'?randomUUID():null,revision=input.expectedRevision+1;
 await client.query("select set_config('erp_financials.maintenance_control_write',txid_current()::text,true)");
 await client.query('insert into erp_financials.accounting_access_commands(command_key,request_digest,revision,active_session_id,actor_ref,operation) values($1,$2,$3,$4,$5,$6::jsonb)',[input.commandKey,digest,revision,activeSessionId,operation.actorRef,JSON.stringify(operation)]);
 await client.query("update erp_financials.accounting_access_control set revision=$1,active_session_id=$2 where control_id='database'",[revision,activeSessionId]);
 await client.query("select set_config('erp_financials.maintenance_control_write','',true)");
 return {revision,activeSessionId,replayed:false};
}

/** Scope an SDK transaction to ordinary access or an explicit active maintenance
 * session. All SDK facades/readers used by a host must share this runner to keep
 * new reports out of a partial store. Database triggers independently guard DML,
 * including old writers. Pre-pause RR read snapshots may finish consistently;
 * writers on stale RR snapshots cannot pass the database write guard.
 * A maintenance session is not an operator grant, nor a production SQL approval.
 * Callers keep those enforced outside this API. No automatic retry or expiry. */
export function withPostgresAccountingAccess(runner:ErpFinancialsTransactionRunner,options:{sessionId?:string}={}):ErpFinancialsTransactionRunner {
 const sessionId=options.sessionId;
 if(sessionId!==undefined&&(typeof sessionId!=='string'||!sessionId||sessionId.length>200))throw invalid('Maintenance session identity is invalid');
 return {transaction:async<Result>(work:(client:PostgresQueryClient)=>Promise<Result>):Promise<Result>=>runner.transaction(async client=>{
  const previous=(await client.query("select current_setting('erp_financials.maintenance_session',true) value")).rows[0]?.value;
  const restore=()=>client.query("select set_config('erp_financials.maintenance_session',$1,true)",[typeof previous==='string'?previous:'']);
  let result:Result;
  try{
   await client.query("select set_config('erp_financials.maintenance_session',$1,true)",[sessionId??'']);
   await client.query('select erp_financials.require_accounting_access(false)');
   result=await work(client);
  }catch(error){
   // An aborted transaction rejects cleanup; preserve the original failure and
   // let the caller-owned transaction roll back the transaction-local setting.
   try{await restore();}catch{ /* outer rollback restores settings */ }
   throw error;
  }
  await restore();
  return result;
 })};
}

export type AccountingHostRelation = { readonly schema: string; readonly table: string };
export type AccountingHostGuardsRequest = {
 readonly acknowledgeDatabaseWideMaintenance: true;
 readonly relations: readonly AccountingHostRelation[];
};
const hostGuardName = 'erp_financials_host_access_guard';
function hostRelations(raw: AccountingHostGuardsRequest): AccountingHostRelation[] {
 const input = structuredClone(raw);
 if ((input.acknowledgeDatabaseWideMaintenance as unknown) !== true || !Array.isArray(input.relations) || input.relations.length < 1 || input.relations.length > 200) {
  throw invalid('Explicit acknowledgment and between one and 200 host relations are required');
 }
 const relations = input.relations.map((relation: AccountingHostRelation | undefined) => {
  if (!relation || [relation.schema, relation.table].some(name => typeof name !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/u.test(name)) ||
   relation.schema === 'erp_financials' || relation.schema === 'information_schema' || relation.schema.startsWith('pg_')) throw invalid('Host relation identifiers are invalid');
  return { schema: relation.schema, table: relation.table };
 }).sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
 if (new Set(relations.map(r => `${r.schema}.${r.table}`)).size !== relations.length) throw invalid('Host relations must be distinct');
 return relations;
}
const hostName = (relation: AccountingHostRelation) => `"${relation.schema}"."${relation.table}"`;
async function inspectHostGuard(client: PostgresQueryClient, relation: AccountingHostRelation) {
 const row = (await client.query(`select c.relkind,c.relispartition,
  exists(select 1 from pg_inherits where inhrelid=c.oid or inhparent=c.oid) inherited,
  t.oid is not null installed,
  (t.tgfoid='erp_financials.guard_accounting_access()'::regprocedure and t.tgtype=62 and t.tgenabled='O'
   and t.tgnargs=0 and t.tgqual is null and not t.tgisinternal and not t.tgdeferrable and not t.tginitdeferred) valid
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  left join pg_trigger t on t.tgrelid=c.oid and t.tgname=$3
  where n.nspname=$1 and c.relname=$2`, [relation.schema, relation.table, hostGuardName])).rows[0];
 if (!row || row.relkind !== 'r' || row.relispartition || row.inherited) throw invalid('Host maintenance guards require existing ordinary, non-inherited tables');
 if (row.installed && row.valid !== true) throw conflict('Host accounting access guard has drifted; explicit repair review required');
 return row.installed === true;
}

/** Explicit installation, not an accounting command or automatic repair. Owns
 * neither transaction nor host authorization. Caller must hold one transaction
 * for this entire call. Existing exact guards are preserved; conflicting or
 * disabled guards are rejected. DDL and active SDK/host writes must be idle.
 * The host chooses its complete source-table set and preserves incoming external
 * evidence separately; no table list or gateway-drain policy is inferred here.
 * Guards share the SDK maintenance session and survive connection/process exit.
 * This does not block unwrapped SELECTs or privileged DDL/replica-role bypass. */
export async function installPostgresAccountingHostGuards(client: PostgresQueryClient, raw: AccountingHostGuardsRequest): Promise<{ relations: readonly AccountingHostRelation[]; installedCount: number }> {
 const relations = hostRelations(raw);
 const acquired = (await client.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired', [lockKey])).rows[0]?.acquired;
 if (acquired !== true) throw conflict('Accounting access is busy; no host guard installed');
 await client.query(`lock table ${relations.map(hostName).join(',')} in access exclusive mode nowait`);
 // Check the complete set before performing any DDL. A caller rollback remains
 // mandatory on errors, including a connection/commit acknowledgment loss.
 const installed: boolean[] = [];
 for (const relation of relations) installed.push(await inspectHostGuard(client, relation));
 for (const [index, relation] of relations.entries()) {
  if (!installed[index]) await client.query(`create trigger ${hostGuardName} before insert or update or delete or truncate on ${hostName(relation)} for each statement execute function erp_financials.guard_accounting_access()`);
 }
 return { relations, installedCount: installed.filter(value => !value).length };
}

/** Bounded schema evidence only, including while paused. This is not a cutover
 * certificate: caller must freeze DDL and verify its own complete table catalog
 * together with financial/source proof before release. Never repairs drift. */
export async function verifyPostgresAccountingHostGuards(client: PostgresQueryClient, raw: AccountingHostGuardsRequest): Promise<{ relations: readonly AccountingHostRelation[] }> {
 const relations = hostRelations(raw);
 for (const relation of relations) if (!await inspectHostGuard(client, relation)) throw conflict('Host accounting access guard is missing');
 return { relations };
}
