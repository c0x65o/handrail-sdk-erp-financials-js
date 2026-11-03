import { describe, expect, it } from 'vitest';
import { lockSubledgerDocumentCoordinates } from '../src/subledger-document-coordinates.js';
import type { PostgresQueryClient, PostgresQueryResult } from '../src/postgres-storage.js';
const scope={tenantId:'tenant',companyId:'company'};
const row=(source_id:string,subledger_document_id='same')=>({tenant_id:'tenant',company_id:'company',source_id,subledger_document_id});
function client(rows:Record<string,unknown>[], calls:unknown[][]=[]):PostgresQueryClient {
 return {query<Row extends Record<string,unknown>>(sql:string,values?:readonly unknown[]):Promise<PostgresQueryResult<Row>>{calls.push([sql,values]);return Promise.resolve({rows:rows as Row[],rowCount:rows.length});}};
}
describe('subledger document source coordinates',()=>{
 it('distinguishes equal document IDs in different sources and locks in deterministic coordinate order',async()=>{
  const calls:unknown[][]=[], historical=row('historical'),native=row('native');
  expect(await lockSubledgerDocumentCoordinates(client([native,historical],calls),scope,{sourceId:'historical',documentId:'same'},{sourceId:'native',documentId:'same'})).toEqual([historical,native]);
  expect(calls[0]?.[0]).toContain('order by source_id,subledger_document_id for update');
  expect(calls[0]?.[1]).toEqual(['tenant','company','historical','same','native','same']);
 });
 it('preserves same-source document loading',async()=>{
  expect(await lockSubledgerDocumentCoordinates(client([row('native','b'),row('native','a')]),scope,{sourceId:'native',documentId:'a'},{sourceId:'native',documentId:'b'})).toEqual([row('native','a'),row('native','b')]);
 });
 it.each(['tenant_id','company_id','source_id'])('rejects mismatched %s rather than selecting by document ID',async key=>{
  await expect(lockSubledgerDocumentCoordinates(client([{...row('historical'),[key]:'foreign'},row('native')]),scope,{sourceId:'historical',documentId:'same'},{sourceId:'native',documentId:'same'})).rejects.toMatchObject({code:'missing_document'});
 });
 it('rejects duplicate rows and identical coordinates',async()=>{
  await expect(lockSubledgerDocumentCoordinates(client([row('historical'),row('historical'),row('native')]),scope,{sourceId:'historical',documentId:'same'},{sourceId:'native',documentId:'same'})).rejects.toMatchObject({code:'missing_document'});
  const calls:unknown[][]=[];
  await expect(lockSubledgerDocumentCoordinates(client([],calls),scope,{sourceId:'native',documentId:'same'},{sourceId:'native',documentId:'same'})).rejects.toMatchObject({code:'invalid_input'});
  expect(calls).toEqual([]);
 });
});
