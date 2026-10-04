import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import console from 'node:console';
import { URL } from 'node:url';
import * as root from '@handrail/erp-financials';
import * as sdk from '@handrail/erp-financials/sdk';

const database = { transaction() { throw new Error('Import smoke must not access a database'); } };
const scope = { database, tenantId: 'synthetic', companyId: 'synthetic', sourceId: 'synthetic', currencyCode: 'USD' };
for (const entry of [root, sdk]) {
  assert.equal(typeof entry.createFinancialActionCommandChecksum, 'function');
  for (const name of ['persistImportedCustomerPaymentEvidence', 'prepareCustomerPaymentCorrectionImport',
    'assertCustomerPaymentCorrectionImportAllowed', 'lockCustomerPaymentCorrectionSource']) {
    assert.equal(typeof entry[name], 'function', name);
  }
}
const financials = root.createErpFinancials(scope);
const client = sdk.createErpFinancialsSdk({ ...scope, bookId: 'synthetic', writeSourceId: 'synthetic' });
for (const payments of [financials.customerPayments, client.commands.customerPayments]) {
  for (const method of ['record', 'previewVoidAndUnapply', 'voidAndUnapply']) assert.equal(typeof payments[method], 'function');
}
assert.equal(root.POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion, 27);
assert.equal(root.POSTGRES_MIGRATIONS.at(-1).toVersion, 27);
const migration = root.POSTGRES_MIGRATIONS.find(row => row.toVersion === 26);
assert.equal(migration.checksum, 'd95d802c6b7a0de6930638f5dd5ebdf951fa2b189d6d5a06fc5d66af091bae81');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(pkg.scripts.prepare, 'npm run build');
console.log(`PASS ${pkg.name}@${pkg.version}: root + /sdk package exports, correction APIs, schema 27, immutable v26 checksum, ordinary prepare build. No database calls.`);
