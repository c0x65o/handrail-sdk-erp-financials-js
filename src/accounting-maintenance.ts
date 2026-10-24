import {POSTGRES_CANONICAL_SCHEMA_MANIFEST as manifest} from './schema-manifest.js';
import {ErpFinancialsError} from './sdk-errors.js';
import type {PostgresQueryClient} from './postgres-storage.js';

export type AccountingMaintenanceClient=PostgresQueryClient&{
 release(error?:Error|boolean):void;
 on(event:'error',listener:(error:Error)=>void):unknown;
 removeListener(event:'error',listener:(error:Error)=>void):unknown;
};
export type AccountingMaintenanceRequest={
  /** All SDK tables in this database are locked, not only the named sources. */
  readonly acknowledgeDatabaseWideLock:true;
  /** Known source command locks, acquired before the transaction snapshot. */
  readonly sources:readonly {readonly tenantId:string;readonly sourceId:string}[];
  /** Host-owned source/intent/link tables that must freeze at the same point. */
  readonly additionalRelations?:readonly {readonly schema:string;readonly table:string}[];
  /** Entire callback deadline; defaults30s, at most60s. No automatic retries. */
  readonly timeoutMs?:number;
};
export type AccountingMaintenanceGuard<Client extends AccountingMaintenanceClient>={
  readonly client:Client;
  readonly transactionId:string;
  readonly lockedRelationCount:number;
  readonly scope:'database';
};
const fail=(message:string)=>new ErpFinancialsError('invalid_input',message);
const identifier=(value:unknown):string=>{
  if(typeof value!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/u.test(value))throw fail('Maintenance relation identifiers must be simple PostgreSQL identifiers');return value;
};
const quote=(name:string)=>`"${name}"`;

/** Explicit bounded maintenance, never an ordinary command/report wrapper.
 * Owns a fresh pool checkout and transaction. Drains declared SDK source writers
 * with nonwaiting session locks, then freezes every SDK table and declared host
 * relation before the first MVCC read. Busy acquisition rolls back; caller must
 * decide whether to try a fresh attempt. No schema/financial mutation, retry,
 * migration approval, gateway operation or cutover certificate is implied.
 * Pool checkouts must be idle and dedicated until release, as for the standard
 * PostgreSQL transaction runner. Callback must use only the supplied client.
 */
export async function withPostgresAccountingMaintenance<Client extends AccountingMaintenanceClient,Result>(
 pool:{connect():Promise<Client>},raw:AccountingMaintenanceRequest,work:(guard:AccountingMaintenanceGuard<Client>)=>Promise<Result>):Promise<Result>{
 const input=structuredClone(raw),timeout=input.timeoutMs??30_000;
 const acknowledgment:unknown=input.acknowledgeDatabaseWideLock;
 if(acknowledgment!==true||typeof work!=='function'||!Number.isInteger(timeout)||timeout<100||timeout>60_000
  ||!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>200)throw fail('Explicit database-wide maintenance acknowledgment,1–200 sources and a100–60000ms deadline are required');
 const keys=input.sources.map((source:AccountingMaintenanceRequest['sources'][number]|undefined)=>{
  if(!source||[source.tenantId,source.sourceId].some(value=>typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>500))throw fail('Maintenance source identities are invalid');
  return `payment-correction:${source.tenantId}:${source.sourceId}`;
 }).sort();
 if(new Set(keys).size!==keys.length)throw fail('Maintenance sources must be distinct');
 if(input.additionalRelations!==undefined&&(!Array.isArray(input.additionalRelations)||input.additionalRelations.length>200))throw fail('Maintenance supports at most200 additional host relations');
 const relations=[...new Set([...manifest.tables.map(table=>`${quote(manifest.namespace)}.${quote(table.name)}`),
  ...(input.additionalRelations??[]).map((relation:{schema:string;table:string}|undefined)=>{if(!relation)throw fail('Maintenance relation is invalid');return `${quote(identifier(relation.schema))}.${quote(identifier(relation.table))}`;})])].sort();
 const rawClient=await pool.connect(),acquired:string[]=[];let started=false,active=false,discard=false;
 let timer:ReturnType<typeof setTimeout>|undefined;
 let connectionError:Error|undefined,rejectConnection:((error:Error)=>void)|undefined;
 const requireActive=()=>{if(!active)throw fail('Accounting maintenance scope has ended');};
 const disconnected=(error:Error)=>{connectionError=error;discard=true;active=false;rejectConnection?.(error);};
 rawClient.on('error',disconnected);
 try{
  // Session-level locks are intentional: all these SELECTs finish in autocommit
  // before BEGIN, so waiting/previous writer snapshots cannot leak into proof.
  for(const key of keys){
   const row=(await rawClient.query('select pg_try_advisory_lock(hashtextextended($1,0)) acquired',[key])).rows[0];
   if(row?.acquired!==true)throw fail('Accounting maintenance source is busy');acquired.push(key);
  }
  await rawClient.query('begin isolation level repeatable read');started=true;
  await rawClient.query(`set local statement_timeout='${String(timeout)}ms'`);
  await rawClient.query(`set local idle_in_transaction_session_timeout='${String(timeout)}ms'`);
  await rawClient.query(`lock table ${relations.join(',')} in share mode nowait`);
  const row=(await rawClient.query('select txid_current()::text transaction_id')).rows[0],transactionId=row?.transaction_id;
  if(typeof transactionId!=='string'||!transactionId)throw fail('Maintenance transaction identity is unavailable');
  if(connectionError)throw connectionError;
  active=true;const deadline=Date.now()+timeout;
  const client=new Proxy(rawClient,{get(target,key,receiver){
   if(key==='release'||key==='end')return ()=>{throw fail('Maintenance owns the connection lifecycle');};
   if(key==='query')return async(...args:unknown[])=>{
    requireActive();
    const text=typeof args[0]==='string'?args[0]:args[0]&&typeof args[0]==='object'&&'text' in args[0]?String(args[0].text):'';
    // Guard accidental early commits/rollbacks through the ordinary query API.
    // This is not a security boundary against a caller with raw DB credentials.
    const plain=text.replace(/\/\*[\s\S]*?\*\//gu,' ').replace(/--[^\n]*/gu,' ');
    // A nested host command may undo its own savepoint without ending this
    // transaction. Permit only one simple ROLLBACK TO statement, never a batch
    // containing transaction control. Ordinary COMMIT/ROLLBACK stay forbidden.
    const rollbackToSavepoint=/^\s*rollback\s+to\s+(?:savepoint\s+)?[a-z_][a-z0-9_]*\s*;?\s*$/iu.test(plain);
    if(!plain.trim()||(!rollbackToSavepoint&&/(?:^|;)\s*(?:begin|commit|end|rollback|abort|start\s+transaction|prepare\s+transaction)\b/iu.test(plain)))throw fail('Maintenance owns transaction control');
    const remaining=deadline-Date.now();if(remaining<=0)throw fail('Accounting maintenance deadline exceeded');
    // SET is rejected in an aborted transaction, but ROLLBACK TO is precisely
    // how a caller recovers from a SQL failure. Retain the previous timeout for
    // that one statement; the wall-clock deadline still applies above/outside.
    if(!rollbackToSavepoint)await rawClient.query(`set local statement_timeout='${String(remaining)}ms'`);
    requireActive();
    return Reflect.apply(target.query.bind(target),target,args) as Promise<unknown>;
   };
   const value:unknown=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target) as unknown:value;
  }});
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{active=false;reject(fail('Accounting maintenance deadline exceeded'));},timeout);});
  const connectionFailed=new Promise<never>((_,reject)=>{rejectConnection=reject;});
  const result=await Promise.race([Promise.resolve().then(()=>work({client,transactionId,lockedRelationCount:relations.length,scope:'database'})),expired,connectionFailed]);
  active=false;if(timer){clearTimeout(timer);timer=undefined;}
  if((await rawClient.query('select txid_current()::text transaction_id')).rows[0]?.transaction_id!==transactionId)throw fail('Maintenance transaction changed');
  await rawClient.query('commit');started=false;return result;
 }catch(error){
  active=false;if(started){try{await rawClient.query('rollback');started=false;}catch{discard=true;}}else{discard=true;}throw error;
 }finally{
  active=false;if(timer)clearTimeout(timer);
  // Session locks must not return to the pool. Destroy an uncertain connection.
  if(!discard){for(const key of acquired.reverse())try{if((await rawClient.query('select pg_advisory_unlock(hashtextextended($1,0)) released',[key])).rows[0]?.released!==true)discard=true;}catch{discard=true;}}
  rawClient.release(discard?new Error('Discarding uncertain accounting maintenance connection'):undefined);
  rawClient.removeListener('error',disconnected);
 }
}
