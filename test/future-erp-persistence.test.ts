import { describe, expect, it } from "vitest";

import {
  ERP_FINANCIALS_STATEMENT_FIXTURE,
  createFutureErpCanonicalFactPersistenceWorker,
  createPostgresStorageAdapter,
  persistFutureErpCanonicalFacts
} from "../src/index.js";

import type {
  Account,
  AccountingDimension,
  AccountingTransaction,
  CanonicalAccountingFactSet,
  FutureErpCanonicalFactPersistenceStorage,
  Item,
  LedgerPosting,
  Party,
  PostgresQueryClient,
  PostgresQueryResult,
  TransactionLine
} from "../src/index.js";

type StorageCall = {
  readonly method: keyof FutureErpCanonicalFactPersistenceStorage;
  readonly count: number;
};

type QueryCall = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

describe("Future ERP canonical fact persistence", () => {
  it("persists canonical facts in dependency order through storage adapter upserts", async () => {
    const storage = new RecordingFactStorage();
    const facts = canonicalFacts();
    const worker = createFutureErpCanonicalFactPersistenceWorker(storage);

    const result = await worker.persist(facts);

    expect(storage.calls.map((call) => call.method)).toEqual([
      "upsertAccountingCompany",
      "upsertAccountingSource",
      "upsertCompanySourceBinding",
      "upsertImportBatch",
      "upsertSyncCheckpoint",
      "upsertAccounts",
      "upsertParties",
      "upsertItems",
      "upsertDimensions",
      "upsertTransactions",
      "upsertTransactionLines",
      "upsertLedgerPostings"
    ]);
    expect(result).toMatchObject({
      tenantId: facts.company.tenantId,
      companyId: facts.company.companyId,
      sourceId: facts.source.sourceId,
      importBatchId: facts.importBatch.importBatchId,
      checkpointId: facts.checkpoint.checkpointId,
      accounts: facts.accounts.length,
      transactionLines: facts.transactionLines.length,
      postings: facts.postings.length
    });
    expect(JSON.stringify(result)).not.toMatch(
      /access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|password|private[_-]?key|rawPayload/i
    );
  });

  it("replays through idempotent upsert SQL instead of duplicate ledger posting inserts", async () => {
    const client = new RecordingPostgresClient();
    const storage = createPostgresStorageAdapter(client);
    const facts = canonicalFacts();

    await persistFutureErpCanonicalFacts(storage, facts);
    await persistFutureErpCanonicalFacts(storage, {
      ...facts,
      postings: facts.postings.map((posting, index) =>
        index === 0
          ? {
              ...posting,
              debitAmount: "50001.00",
              netAmount: "50001.00"
            }
          : posting
      )
    });

    const ledgerPostingCalls = client.calls.filter((call) => call.sql.includes('"ledger_postings"'));

    expect(ledgerPostingCalls).toHaveLength(2);
    expect(ledgerPostingCalls[0]?.sql).toContain(
      'on conflict ("tenant_id", "source_id", "accounting_basis", "source_posting_id") do update'
    );
    expect(ledgerPostingCalls[1]?.sql).toBe(ledgerPostingCalls[0]?.sql);
    expect(ledgerPostingCalls[1]?.params).toEqual(expect.arrayContaining(["50001.00"]));
    expect(ledgerPostingCalls.every((call) => call.sql.includes("on conflict"))).toBe(true);
  });

  it("uses canonical identity conflict targets for canonical fact upserts", async () => {
    const client = new RecordingPostgresClient();
    const storage = createPostgresStorageAdapter(client);

    await persistFutureErpCanonicalFacts(storage, canonicalFacts());

    expect(conflictTargetFor(client.calls, "accounting_companies")).toBe('"company_id"');
    expect(conflictTargetFor(client.calls, "accounting_sources")).toBe(
      '"tenant_id", "source_system", "provider_environment", "connection_ref"'
    );
    expect(conflictTargetFor(client.calls, "import_batches")).toBe('"tenant_id", "source_id", "import_batch_id"');
    expect(conflictTargetFor(client.calls, "sync_checkpoints")).toBe(
      '"tenant_id", "source_id", "source_object", "cursor_kind"'
    );
    expect(conflictTargetFor(client.calls, "accounts")).toBe('"tenant_id", "source_id", "source_account_id"');
    expect(conflictTargetFor(client.calls, "parties")).toBe('"tenant_id", "source_id", "source_party_id"');
    expect(conflictTargetFor(client.calls, "items")).toBe('"tenant_id", "source_id", "source_item_id"');
    expect(conflictTargetFor(client.calls, "accounting_dimensions")).toBe(
      '"tenant_id", "source_id", "dimension_kind", "source_dimension_id"'
    );
    expect(conflictTargetFor(client.calls, "transactions")).toBe(
      '"tenant_id", "source_id", "source_transaction_type", "source_transaction_id"'
    );
    expect(conflictTargetFor(client.calls, "transaction_lines")).toBe(
      '"tenant_id", "source_id", "transaction_id", "line_number"'
    );
    expect(conflictTargetFor(client.calls, "ledger_postings")).toBe(
      '"tenant_id", "source_id", "accounting_basis", "source_posting_id"'
    );
  });

  it("rejects credential-like fact keys before any persistence calls", async () => {
    const storage = new RecordingFactStorage();
    const facts = {
      ...canonicalFacts(),
      importBatch: {
        ...canonicalFacts().importBatch,
        warningSummary: {
          access_token: "not persisted"
        }
      }
    };

    await expect(persistFutureErpCanonicalFacts(storage, facts)).rejects.toThrow("credential-like field is not allowed");
    expect(storage.calls).toEqual([]);
  });
});

class RecordingFactStorage implements FutureErpCanonicalFactPersistenceStorage {
  readonly calls: StorageCall[] = [];

  upsertAccountingCompany(): Promise<number> {
    return this.record("upsertAccountingCompany", 1);
  }

  upsertAccountingSource(): Promise<number> {
    return this.record("upsertAccountingSource", 1);
  }

  upsertCompanySourceBinding(): Promise<number> {
    return this.record("upsertCompanySourceBinding", 1);
  }

  upsertImportBatch(): Promise<number> {
    return this.record("upsertImportBatch", 1);
  }

  upsertSyncCheckpoint(): Promise<number> {
    return this.record("upsertSyncCheckpoint", 1);
  }

  upsertAccounts(accounts: readonly Account[]): Promise<number> {
    return this.record("upsertAccounts", accounts.length);
  }

  upsertParties(parties: readonly Party[]): Promise<number> {
    return this.record("upsertParties", parties.length);
  }

  upsertItems(items: readonly Item[]): Promise<number> {
    return this.record("upsertItems", items.length);
  }

  upsertDimensions(dimensions: readonly AccountingDimension[]): Promise<number> {
    return this.record("upsertDimensions", dimensions.length);
  }

  upsertTransactions(transactions: readonly AccountingTransaction[]): Promise<number> {
    return this.record("upsertTransactions", transactions.length);
  }

  upsertTransactionLines(lines: readonly TransactionLine[]): Promise<number> {
    return this.record("upsertTransactionLines", lines.length);
  }

  upsertLedgerPostings(postings: readonly LedgerPosting[]): Promise<number> {
    return this.record("upsertLedgerPostings", postings.length);
  }

  private record(method: keyof FutureErpCanonicalFactPersistenceStorage, count: number): Promise<number> {
    this.calls.push({ method, count });

    return Promise.resolve(count);
  }
}

class RecordingPostgresClient implements PostgresQueryClient {
  readonly calls: QueryCall[] = [];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });

    return Promise.resolve({
      rows: [],
      rowCount: null
    });
  }
}

function conflictTargetFor(calls: readonly QueryCall[], tableName: string): string {
  const call = calls.find((entry) => entry.sql.trimStart().startsWith("insert into ") && entry.sql.includes(`"erp_financials"."${tableName}"`));
  const conflictTarget = call?.sql.match(/on conflict \(([^)]+)\)/)?.[1];

  if (conflictTarget === undefined) {
    throw new Error(`Expected conflict target for ${tableName}`);
  }

  return conflictTarget;
}

function canonicalFacts(): CanonicalAccountingFactSet {
  return {
    company: ERP_FINANCIALS_STATEMENT_FIXTURE.company,
    source: ERP_FINANCIALS_STATEMENT_FIXTURE.source,
    importBatch: ERP_FINANCIALS_STATEMENT_FIXTURE.importBatch,
    checkpoint: ERP_FINANCIALS_STATEMENT_FIXTURE.checkpoint,
    accounts: ERP_FINANCIALS_STATEMENT_FIXTURE.accounts,
    parties: ERP_FINANCIALS_STATEMENT_FIXTURE.parties,
    items: ERP_FINANCIALS_STATEMENT_FIXTURE.items,
    dimensions: ERP_FINANCIALS_STATEMENT_FIXTURE.dimensions,
    transactions: ERP_FINANCIALS_STATEMENT_FIXTURE.transactions,
    transactionLines: ERP_FINANCIALS_STATEMENT_FIXTURE.transactionLines,
    postings: ERP_FINANCIALS_STATEMENT_FIXTURE.postings
  };
}
