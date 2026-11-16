import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
const url = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.includes('test')) throw Error('Isolated database required');
(url ? describe.sequential : describe.skip)('lifecycle retirement guard access path', () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  afterAll(async () => { await pool.end(); });
  it('avoids scanning unrelated import evidence and still rejects retired identities', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('drop schema if exists erp_financials cascade; create schema erp_financials');
      await c.query(`create table erp_financials.financial_lifecycle_events (
        tenant_id text, company_id text, source_id text, event_type text, aggregate_id text, payload jsonb);
        create index lifecycle_scope on erp_financials.financial_lifecycle_events(tenant_id,company_id,source_id);
        create table erp_financials.subledger_applications(tenant_id text,company_id text,source_id text,subledger_application_id text,source_document_id text);
        create table erp_financials.subledger_documents(tenant_id text,company_id text,source_id text,subledger_document_id text);
        insert into erp_financials.financial_lifecycle_events
        select 'test','company','source','quickbooks_document_imported',n::text,jsonb_build_object('detail',repeat(md5(n::text),100)) from generate_series(1,20000) n;
        analyze erp_financials.financial_lifecycle_events`);
      const predicate = `select 1 from erp_financials.financial_lifecycle_events where tenant_id='test' and company_id='company' and source_id='source' and event_type='customer_payment.attested_settlement_corrected' and (payload->>'endedApplicationId'='application' or aggregate_id='receipt')`;
      const before = JSON.stringify((await c.query(`explain (analyze, buffers, format json) ${predicate}`)).rows);
      expect(before).toContain('Rows Removed by Filter');
      await c.query(readFileSync(new URL('../migrations/future-erp/20261116010000_lifecycle_event_type_index.sql', import.meta.url), 'utf8'));
      const after = JSON.stringify((await c.query(`explain (analyze, buffers, format json) ${predicate}`)).rows);
      expect(after).toContain('financial_lifecycle_events_type_scope_idx');
      expect(after).not.toContain('"Rows Removed by Filter":20000');
      const original = readFileSync(new URL('../migrations/future-erp/20261106020000_attested_settlement.sql', import.meta.url), 'utf8');
      const guard = original.slice(original.indexOf('create function erp_financials.guard_attested_settlement_retirement()'), original.indexOf('-- Spartan installs'));
      await c.query(guard);
      await c.query(`insert into erp_financials.subledger_applications values ('test','company','source','ordinary','ordinary-receipt');
        insert into erp_financials.subledger_documents values ('test','company','source','receipt');
        insert into erp_financials.financial_lifecycle_events values ('test','company','source','customer_payment.attested_settlement_corrected','receipt','{"endedApplicationId":"application"}')`);
      for (const statement of [
        `insert into erp_financials.subledger_applications values ('test','company','source','application','other')`,
        `insert into erp_financials.subledger_applications values ('test','company','source','other','receipt')`,
        `update erp_financials.subledger_documents set subledger_document_id=subledger_document_id where subledger_document_id='receipt'`,
      ]) {
        await c.query('savepoint rejected');
        await expect(c.query(statement)).rejects.toThrow('immutable');
        await c.query('rollback to savepoint rejected');
      }
      await c.query(`insert into erp_financials.subledger_applications values ('other-tenant','company','source','application','receipt')`);
    } finally { await c.query('rollback'); c.release(); }
  }, 30000);
});
