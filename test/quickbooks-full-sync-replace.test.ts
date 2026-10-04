import { describe, expect, it } from "vitest";

import {
  ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  createPostgresStorageAdapter,
  createQuickBooksFullSyncWorker
} from "../src/index.js";
import type {
  Account,
  AccountingDimension,
  AccountingTransaction,
  DeleteLedgerFactsOutsideImportBatchInput,
  Item,
  LedgerPosting,
  Party,
  PostgresQueryClient,
  PostgresQueryResult,
  TransactionLine
} from "../src/index.js";

type QueryCall = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

class DeleteRecordingClient implements PostgresQueryClient {
  readonly calls: QueryCall[] = [];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });
    const rowCount = /^delete from "erp_financials"\."ledger_postings"/.test(sql.trim())
      ? 4
      : /transaction_lines/.test(sql)
        ? 3
        : /transactions/.test(sql)
          ? 2
          : 0;
    return Promise.resolve({ rows: [], rowCount });
  }
}

class ReplaceRecordingStorage {
  readonly deletedScopes: DeleteLedgerFactsOutsideImportBatchInput[] = [];
  persistedBeforeDelete = false;
  private persistedPostings = 0;

  upsertAccountingCompany(): Promise<number> {
    return Promise.resolve(1);
  }
  upsertAccountingSource(): Promise<number> {
    return Promise.resolve(1);
  }
  upsertCompanySourceBinding(): Promise<number> {
    return Promise.resolve(1);
  }
  upsertImportBatch(): Promise<number> {
    return Promise.resolve(1);
  }
  upsertSyncCheckpoint(): Promise<number> {
    return Promise.resolve(1);
  }
  upsertAccounts(accounts: readonly Account[]): Promise<number> {
    return Promise.resolve(accounts.length);
  }
  upsertParties(parties: readonly Party[]): Promise<number> {
    return Promise.resolve(parties.length);
  }
  upsertItems(items: readonly Item[]): Promise<number> {
    return Promise.resolve(items.length);
  }
  upsertDimensions(dimensions: readonly AccountingDimension[]): Promise<number> {
    return Promise.resolve(dimensions.length);
  }
  upsertTransactions(transactions: readonly AccountingTransaction[]): Promise<number> {
    return Promise.resolve(transactions.length);
  }
  upsertTransactionLines(lines: readonly TransactionLine[]): Promise<number> {
    return Promise.resolve(lines.length);
  }
  upsertLedgerPostings(postings: readonly LedgerPosting[]): Promise<number> {
    this.persistedPostings = postings.length;
    return Promise.resolve(postings.length);
  }
  deleteLedgerFactsOutsideImportBatch(input: DeleteLedgerFactsOutsideImportBatchInput) {
    this.persistedBeforeDelete = this.persistedPostings > 0;
    this.deletedScopes.push(input);
    return Promise.resolve({ postings: 5, transactionLines: 2, transactions: 1 });
  }
}

describe("full sync ledger fact replacement", () => {
  it("deletes stale postings then orphaned lines and transactions scoped to tenant/source", async () => {
    const client = new DeleteRecordingClient();
    const storage = createPostgresStorageAdapter(client, POSTGRES_CANONICAL_SCHEMA_MANIFEST);

    const result = await storage.deleteLedgerFactsOutsideImportBatch({
      tenantId: "tenant_replace",
      sourceId: "source_quickbooks",
      importBatchId: "batch_provider_gl_2026_07"
    });

    expect(result).toEqual({ postings: 4, transactionLines: 3, transactions: 2 });
    expect(client.calls).toHaveLength(8);
    expect(client.calls[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(client.calls[1]?.sql).toContain("customer_payment_corrections");
    expect(client.calls[2]?.sql).toContain("subledger_documents");
    expect(client.calls[3]?.sql).toContain("quickbooks_projection_refresh', 'on'");
    expect(client.calls[4]?.sql).toContain('delete from "erp_financials"."ledger_postings"');
    expect(client.calls[4]?.sql).toContain('"import_batch_id" <> $3');
    expect(client.calls[4]?.params).toEqual(["tenant_replace", "source_quickbooks", "batch_provider_gl_2026_07", []]);
    expect(client.calls[5]?.sql).toContain('delete from "erp_financials"."transaction_lines"');
    expect(client.calls[5]?.sql).toContain("not exists");
    expect(client.calls[5]?.params).toEqual(["tenant_replace", "source_quickbooks"]);
    expect(client.calls[6]?.sql).toContain('delete from "erp_financials"."transactions"');
    expect(client.calls[6]?.sql).toContain("not exists");
    expect(client.calls[6]?.params).toEqual(["tenant_replace", "source_quickbooks"]);
    expect(client.calls[7]?.sql).toContain("quickbooks_projection_refresh', 'off'");
  });

  it("rejects empty scope identifiers", async () => {
    const storage = createPostgresStorageAdapter(new DeleteRecordingClient(), POSTGRES_CANONICAL_SCHEMA_MANIFEST);

    await expect(
      storage.deleteLedgerFactsOutsideImportBatch({ tenantId: "", sourceId: "s", importBatchId: "b" })
    ).rejects.toThrow(/requires tenantId, sourceId, and importBatchId/);
  });

  it("replaces ledger facts after persisting a full sync when opted in", async () => {
    const fixture = ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync;
    const storage = new ReplaceRecordingStorage();
    const worker = createQuickBooksFullSyncWorker({
      quickBooksClient: {
        fullSync: () => Promise.resolve(fixture.response)
      },
      persistence: storage,
      companyId: "company_core_erp_qbo_fixture",
      accountingBasis: "accrual",
      currencyCode: "USD",
      replaceLedgerFactsOnFullSync: true
    });

    const result = await worker.fullSync(fixture.request);

    expect(storage.persistedBeforeDelete).toBe(true);
    expect(storage.deletedScopes).toEqual([
      {
        tenantId: "tenant_qbo_sync_fixture",
        sourceId: "source_qbo_sync_fixture",
        importBatchId: "batch_qbo_full_fixture_2026_01"
      }
    ]);
    expect(result.removedLedgerFacts).toEqual({ postings: 5, transactionLines: 2, transactions: 1 });
  });

  it("does not delete ledger facts unless explicitly opted in", async () => {
    const fixture = ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync;
    const storage = new ReplaceRecordingStorage();
    const worker = createQuickBooksFullSyncWorker({
      quickBooksClient: {
        fullSync: () => Promise.resolve(fixture.response)
      },
      persistence: storage,
      companyId: "company_core_erp_qbo_fixture",
      accountingBasis: "accrual",
      currencyCode: "USD"
    });

    const result = await worker.fullSync(fixture.request);

    expect(storage.deletedScopes).toEqual([]);
    expect(result.removedLedgerFacts).toBeUndefined();
  });

  it("fails fast when replacement is requested without storage support", async () => {
    const fixture = ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync;
    const recording = new ReplaceRecordingStorage();
    const storage = {
      upsertAccountingCompany: recording.upsertAccountingCompany.bind(recording),
      upsertAccountingSource: recording.upsertAccountingSource.bind(recording),
      upsertCompanySourceBinding: recording.upsertCompanySourceBinding.bind(recording),
      upsertImportBatch: recording.upsertImportBatch.bind(recording),
      upsertSyncCheckpoint: recording.upsertSyncCheckpoint.bind(recording),
      upsertAccounts: recording.upsertAccounts.bind(recording),
      upsertParties: recording.upsertParties.bind(recording),
      upsertItems: recording.upsertItems.bind(recording),
      upsertDimensions: recording.upsertDimensions.bind(recording),
      upsertTransactions: recording.upsertTransactions.bind(recording),
      upsertTransactionLines: recording.upsertTransactionLines.bind(recording),
      upsertLedgerPostings: recording.upsertLedgerPostings.bind(recording)
    };
    const worker = createQuickBooksFullSyncWorker({
      quickBooksClient: {
        fullSync: () => Promise.resolve(fixture.response)
      },
      persistence: storage,
      companyId: "company_core_erp_qbo_fixture",
      accountingBasis: "accrual",
      currencyCode: "USD",
      replaceLedgerFactsOnFullSync: true
    });

    await expect(worker.fullSync(fixture.request)).rejects.toThrow(
      /requires persistence storage that implements deleteLedgerFactsOutsideImportBatch/
    );
  });
});
